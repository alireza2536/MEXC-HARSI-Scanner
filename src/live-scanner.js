import pg from "pg";
import { config, validateConfig } from "./config.js";
import { MexcClient } from "./mexc-client.js";
import { calculateHarsi } from "./harsi.js";
import { hasCompleteCandleWindow } from "./candle-history-cache.js";

const { Pool } = pg;
const CANDLE_SECONDS = 15 * 60;
const CANDLE_MS = CANDLE_SECONDS * 1000;
const HISTORY_CANDLES = 2000;
const HISTORY_BATCH_SIZE = 500;
const log = (event, details = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
};

function currentCandleFrom(candles, currentOpen) {
  return candles.find((candle) => Date.parse(candle.open_time) === currentOpen * 1000);
}

function normalizeDatabaseCandles(rows) {
  return rows.map((row) => ({
    ...row,
    open_time: new Date(row.open_time).toISOString(),
    close_time: new Date(row.close_time).toISOString()
  }));
}

async function upsertHistoricalCandles(pool, candles) {
  for (let offset = 0; offset < candles.length; offset += HISTORY_BATCH_SIZE) {
    const batch = candles.slice(offset, offset + HISTORY_BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((candle, index) => {
      const base = index * 9;
      values.push(
        candle.symbol, candle.open_time, candle.close_time,
        candle.open_price, candle.high_price, candle.low_price,
        candle.close_price, candle.volume, candle.amount
      );
      return "(" + Array.from({ length: 9 }, (_, field) => "$" + (base + field + 1)).join(",") + ")";
    }).join(",");

    const sql = "INSERT INTO public.mexc_futures_ohlcv_15m " +
      "(symbol, open_time, close_time, open_price, high_price, low_price, close_price, volume, amount) " +
      "VALUES " + placeholders +
      " ON CONFLICT (symbol, open_time) DO UPDATE SET " +
      "close_time=EXCLUDED.close_time, open_price=EXCLUDED.open_price, " +
      "high_price=EXCLUDED.high_price, low_price=EXCLUDED.low_price, " +
      "close_price=EXCLUDED.close_price, volume=EXCLUDED.volume, " +
      "amount=EXCLUDED.amount, updated_at=now()";

    await pool.query(sql, values);
  }
}

async function getHistoricalCandles(pool, mexc, symbol, currentOpen) {
  const cachedResult = await pool.query(
    "SELECT symbol, open_time, close_time, open_price, high_price, low_price, " +
      "close_price, volume, amount " +
      "FROM public.mexc_futures_ohlcv_15m " +
      "WHERE symbol = $1 AND open_time < to_timestamp($2) " +
      "ORDER BY open_time DESC LIMIT $3",
    [symbol, currentOpen, HISTORY_CANDLES]
  );
  const cached = normalizeDatabaseCandles(cachedResult.rows).reverse();
  const expectedLastOpen = (currentOpen - CANDLE_SECONDS) * 1000;

  if (hasCompleteCandleWindow(cached, HISTORY_CANDLES, expectedLastOpen, CANDLE_MS)) {
    return { candles: cached, cacheHit: true };
  }

  const startSeconds = currentOpen - (HISTORY_CANDLES * CANDLE_SECONDS);
  const historicalResponse = await mexc.get15mCandles(
    symbol,
    startSeconds,
    currentOpen - 1
  );
  const historical = historicalResponse
    .filter((candle) => Date.parse(candle.open_time) < currentOpen * 1000)
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
    .slice(-HISTORY_CANDLES);

  if (historical.length !== HISTORY_CANDLES) {
    throw new Error(
      "History is incomplete: expected " + HISTORY_CANDLES +
      " prior candles, received " + historical.length
    );
  }
  await upsertHistoricalCandles(pool, historical);
  return { candles: historical, cacheHit: false };
}

async function saveCurrentCandle(pool, current) {
  await pool.query(
    "INSERT INTO public.mexc_futures_ohlcv_15m " +
      "(symbol, open_time, close_time, open_price, high_price, low_price, close_price, volume, amount) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
      "ON CONFLICT (symbol, open_time) DO UPDATE SET " +
      "close_time=EXCLUDED.close_time, open_price=EXCLUDED.open_price, " +
      "high_price=EXCLUDED.high_price, low_price=EXCLUDED.low_price, " +
      "close_price=EXCLUDED.close_price, volume=EXCLUDED.volume, " +
      "amount=EXCLUDED.amount, updated_at=now()",
    [current.symbol, current.open_time, current.close_time, current.open_price,
      current.high_price, current.low_price, current.close_price, current.volume, current.amount]
  );

  // Keep the rolling cache bounded to the 2,000 closed candles plus the current candle.
  await pool.query(
    "DELETE FROM public.mexc_futures_ohlcv_15m " +
      "WHERE symbol = $1 AND open_time < (" +
      "SELECT open_time FROM public.mexc_futures_ohlcv_15m " +
      "WHERE symbol = $1 ORDER BY open_time DESC OFFSET $2 LIMIT 1)",
    [current.symbol, HISTORY_CANDLES]
  );
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
    // Keep only the most recent seven days of HARSI result history.
    await pool.query(
      "DELETE FROM public.mexc_harsi_results_15m " +
        "WHERE close_time < now() - interval '7 days'"
    );

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
    let historyCacheHits = 0;
    let historyBackfills = 0;
    const results = [];

    for (const contract of contracts) {
      try {
        const history = await getHistoricalCandles(pool, mexc, contract.symbol, currentOpen);
        if (history.cacheHit) historyCacheHits += 1;
        else historyBackfills += 1;

        const currentResponse = await mexc.get15mCandles(
          contract.symbol,
          currentOpen,
          nowSeconds
        );
        const current = currentCandleFrom(currentResponse, currentOpen);
        if (!current) {
          throw new Error("MEXC did not return the currently forming 15m candle.");
        }

        const candles = [...history.candles, current];
        const currentHarsi = calculateHarsi(candles)
          .find((row) => row.open_time === current.open_time);
        if (!currentHarsi) {
          throw new Error("HARSI value is not ready for the current candle.");
        }

        await saveCurrentCandle(pool, current);

        await pool.query(
          "INSERT INTO public.mexc_harsi_results_15m " +
            "(symbol, open_time, close_time, rsi_open, rsi_high, rsi_low, rsi_close, " +
            "ha_open, ha_high, ha_low, ha_close, scan_match, calculation_version) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12) " +
            "ON CONFLICT (symbol, open_time) DO UPDATE SET " +
            "close_time=EXCLUDED.close_time, rsi_open=EXCLUDED.rsi_open, " +
            "rsi_high=EXCLUDED.rsi_high, rsi_low=EXCLUDED.rsi_low, " +
            "rsi_close=EXCLUDED.rsi_close, ha_open=EXCLUDED.ha_open, " +
            "ha_high=EXCLUDED.ha_high, ha_low=EXCLUDED.ha_low, ha_close=EXCLUDED.ha_close, " +
            "scan_match=NULL, calculation_version=EXCLUDED.calculation_version, updated_at=now()",
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
      historyCacheHits,
      historyBackfills,
      candleOpenTime: new Date(currentOpen * 1000).toISOString(),
      completedAt: new Date().toISOString(),
      results
    };

    log("live_scan_completed", {
      timeframe: "Min15",
      eligibleContracts: contracts.length,
      updatedContracts,
      failedContracts,
      historyCacheHits,
      historyBackfills,
      candleOpenTime: summary.candleOpenTime
    });
    return summary;
  } finally {
    await pool.end();
  }
}
