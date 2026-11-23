import pg from "pg";
import { config, validateConfig } from "./config.js";
import { MexcClient } from "./mexc-client.js";
import { calculateHarsi } from "./harsi.js";

const { Pool } = pg;
const CANDLE_SECONDS = 15 * 60;
const HISTORY_CANDLES = 2000;
const log = (event, details = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
};

function currentCandleFrom(candles, currentOpen) {
  return candles.find((candle) => Date.parse(candle.open_time) === currentOpen * 1000);
}

export async function runLiveScan() {
  validateConfig();
  const mexc = new MexcClient();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true }
  });

  try {
    const serverNowMs = await mexc.getServerTimeMs();
    const nowSeconds = Math.floor(serverNowMs / 1000);
    const currentOpen = Math.floor(nowSeconds / CANDLE_SECONDS) * CANDLE_SECONDS;
    const contracts = await mexc.getEligibleUsdtContracts(config.maxPrice);

    log("live_scan_started", {
      timeframe: "Min15",
      eligibleContracts: contracts.length,
      historicalCandles: HISTORY_CANDLES,
      currentCandleOpen: currentOpen
    });

    let updatedContracts = 0;
    let failedContracts = 0;
    const results = [];

    for (const contract of contracts) {
      try {
        const startSeconds = currentOpen - (HISTORY_CANDLES * CANDLE_SECONDS);
        const historicalResponse = await mexc.get15mCandles(
          contract.symbol,
          startSeconds,
          currentOpen - 1
        );
        const historical = historicalResponse
          .filter((candle) => Date.parse(candle.open_time) < currentOpen * 1000)
          .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
          .slice(-HISTORY_CANDLES);

        if (historical.length !== HISTORY_CANDLES) {
          throw new Error(
            `History is incomplete: expected ${HISTORY_CANDLES} prior candles, received ${historical.length}`
          );
        }

        const currentResponse = await mexc.get15mCandles(
          contract.symbol,
          currentOpen,
          nowSeconds
        );
        const current = currentCandleFrom(currentResponse, currentOpen);
        if (!current) {
          throw new Error("MEXC did not return the currently forming 15m candle.");
        }

        const candles = [...historical, current];
        const currentHarsi = calculateHarsi(candles)
          .find((row) => row.open_time === current.open_time);
        if (!currentHarsi) {
          throw new Error("HARSI value is not ready for the current candle.");
        }

        await pool.query(
          `INSERT INTO public.mexc_futures_ohlcv_15m
            (symbol, open_time, close_time, open_price, high_price, low_price, close_price, volume, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (symbol, open_time) DO UPDATE SET
             close_time=EXCLUDED.close_time,
             open_price=EXCLUDED.open_price,
             high_price=EXCLUDED.high_price,
             low_price=EXCLUDED.low_price,
             close_price=EXCLUDED.close_price,
             volume=EXCLUDED.volume,
             amount=EXCLUDED.amount,
             updated_at=now()`,
          [current.symbol, current.open_time, current.close_time, current.open_price,
            current.high_price, current.low_price, current.close_price, current.volume, current.amount]
        );

        await pool.query(
          `INSERT INTO public.mexc_harsi_results_15m
            (symbol, open_time, close_time, rsi_open, rsi_high, rsi_low, rsi_close,
             ha_open, ha_high, ha_low, ha_close, scan_match, calculation_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12)
           ON CONFLICT (symbol, open_time) DO UPDATE SET
             close_time=EXCLUDED.close_time,
             rsi_open=EXCLUDED.rsi_open,
             rsi_high=EXCLUDED.rsi_high,
             rsi_low=EXCLUDED.rsi_low,
             rsi_close=EXCLUDED.rsi_close,
             ha_open=EXCLUDED.ha_open,
             ha_high=EXCLUDED.ha_high,
             ha_low=EXCLUDED.ha_low,
             ha_close=EXCLUDED.ha_close,
             scan_match=NULL,
             calculation_version=EXCLUDED.calculation_version,
             updated_at=now()`,
          [currentHarsi.symbol, currentHarsi.open_time, currentHarsi.close_time,
            currentHarsi.rsi_open, currentHarsi.rsi_high, currentHarsi.rsi_low, currentHarsi.rsi_close,
            currentHarsi.ha_open, currentHarsi.ha_high, currentHarsi.ha_low, currentHarsi.ha_close,
            currentHarsi.calculation_version]
        );

        updatedContracts += 1;
        results.push({
          symbol: contract.symbol,
          lastPrice: contract.lastPrice,
          candleClose: current.close_price,
          haClose: currentHarsi.ha_close,
          candleOpenTime: current.open_time
        });
      } catch (error) {
        failedContracts += 1;
        log("live_contract_failed", { symbol: contract.symbol, error: error.message });
      }
    }

    const summary = {
      eligibleContracts: contracts.length,
      updatedContracts,
      failedContracts,
      candleOpenTime: new Date(currentOpen * 1000).toISOString(),
      completedAt: new Date().toISOString(),
      results
    };

    log("live_scan_completed", {
      timeframe: "Min15",
      eligibleContracts: contracts.length,
      updatedContracts,
      failedContracts,
      candleOpenTime: summary.candleOpenTime
    });
    return summary;
  } finally {
    await pool.end();
  }
}
