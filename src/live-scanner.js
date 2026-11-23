import pg from "pg";
import { config, validateConfig } from "./config.js";
import { MexcClient } from "./mexc-client.js";
import { calculateHarsi } from "./harsi.js";
import { mergeCandleHistory } from "./candle-history-cache.js";

const { Pool } = pg;
const CANDLE_SECONDS = 15 * 60;
const HISTORY_CANDLES = 2000;
const CACHE_LIMIT = HISTORY_CANDLES + 1;
const PILOT_SYMBOL = "ONE_USDT";

// This cache lives only in the running server process. It is intentionally
// not written to the database and is rebuilt after a process restart.
let cachedCandles = [];

const log = (event, details = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
};

function currentCandleFrom(candles, currentOpen) {
  return candles.find((candle) => Date.parse(candle.open_time) === currentOpen * 1000);
}

/**
 * One-shot, read-only diagnostic for comparing 2,000 vs 2,323 prior ONE candles.
 * It does not touch the live cache or database.
 */
const DIAGNOSTIC_SYMBOLS = new Set(["ONE_USDT", "TA_USDT"]);

export async function runOneHistoryDiagnostic(symbol = PILOT_SYMBOL) {
  if (!DIAGNOSTIC_SYMBOLS.has(symbol)) throw new Error("این نماد برای آزمایش مجاز نیست.");
  const mexc = new MexcClient();
  const serverNowMs = await mexc.getServerTimeMs();
  const nowSeconds = Math.floor(serverNowMs / 1000);
  const currentOpen = Math.floor(nowSeconds / CANDLE_SECONDS) * CANDLE_SECONDS;
  const latestStart = currentOpen - (HISTORY_CANDLES * CANDLE_SECONDS);
  const extendedStart = currentOpen - (2322 * CANDLE_SECONDS);

  const [latestHistory, extendedHistory, currentResponse] = await Promise.all([
    mexc.get15mCandles(symbol, latestStart, currentOpen - 1),
    mexc.get15mCandles(symbol, extendedStart, latestStart - 1),
    mexc.get15mCandles(symbol, currentOpen, nowSeconds)
  ]);

  const prior = [...extendedHistory, ...latestHistory]
    .filter((candle) => Date.parse(candle.open_time) < currentOpen * 1000)
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
  const uniquePrior = [...new Map(prior.map((candle) => [candle.open_time, candle])).values()];
  if (uniquePrior.length !== 2322) {
    throw new Error(`${symbol} diagnostic history is incomplete: expected 2322 prior candles, received ${uniquePrior.length}`);
  }

  const current = currentCandleFrom(currentResponse, currentOpen);
  if (!current) throw new Error(`MEXC did not return the current ${symbol} candle for diagnostic.`);

  const history2000 = [...uniquePrior.slice(-2000), current];
  const history2323 = [...uniquePrior.slice(-2322), current];
  const result2000 = calculateHarsi(history2000).find((row) => row.open_time === current.open_time);
  const result2323 = calculateHarsi(history2323).find((row) => row.open_time === current.open_time);
  if (!result2000 || !result2323) throw new Error("HARSI diagnostic result is not ready.");

  const result = {
    symbol: symbol,
    timeframe: "Min15",
    calculationVersion: result2323.calculation_version,
    candleOpenTime: current.open_time,
    candleState: "currently_forming",
    candleCounts: { comparisonTotal: 2001, extendedTotal: 2323 },
    comparison: {
      priorCandles: 2000,
      totalCandlesIncludingCurrent: history2000.length,
      haClose: result2000.ha_close
    },
    extended: {
      priorCandles: 2322,
      totalCandlesIncludingCurrent: history2323.length,
      haClose: result2323.ha_close
    },
    difference: result2323.ha_close - result2000.ha_close,
    currentCandle: {
      open: current.open_price,
      high: current.high_price,
      low: current.low_price,
      close: current.close_price
    },
    completedAt: new Date().toISOString()
  };
  log("harsi_history_diagnostic_completed", result);
  return result;
}

async function bootstrapOneHistory(mexc, currentOpen, nowSeconds) {
  const startSeconds = currentOpen - (HISTORY_CANDLES * CANDLE_SECONDS);
  const historicalResponse = await mexc.get15mCandles(
    PILOT_SYMBOL,
    startSeconds,
    currentOpen - 1
  );
  const historical = historicalResponse
    .filter((candle) => Date.parse(candle.open_time) < currentOpen * 1000)
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
    .slice(-HISTORY_CANDLES);

  if (historical.length !== HISTORY_CANDLES) {
    throw new Error(
      `ONE history is incomplete: expected ${HISTORY_CANDLES} prior candles, received ${historical.length}`
    );
  }

  const currentResponse = await mexc.get15mCandles(
    PILOT_SYMBOL,
    currentOpen,
    nowSeconds
  );
  const current = currentCandleFrom(currentResponse, currentOpen);
  if (!current) {
    throw new Error("MEXC did not return the currently forming ONE candle.");
  }

  return mergeCandleHistory(historical, [current], CACHE_LIMIT);
}

async function getOneCandles(mexc, currentOpen, nowSeconds) {
  if (cachedCandles.length === 0) {
    const initial = await bootstrapOneHistory(mexc, currentOpen, nowSeconds);
    cachedCandles = initial;
    log("one_history_initialized", {
      historicalCandles: HISTORY_CANDLES,
      totalCandlesInMemory: cachedCandles.length
    });
    return cachedCandles;
  }

  const lastCachedOpen = Math.floor(Date.parse(cachedCandles.at(-1).open_time) / 1000);
  const missingBars = Math.floor((currentOpen - lastCachedOpen) / CANDLE_SECONDS);

  // If the process was inactive long enough that an incremental response
  // could exceed MEXC's 2,000-point limit, rebuild the cache in two requests.
  if (missingBars > HISTORY_CANDLES - 1) {
    const rebuilt = await bootstrapOneHistory(mexc, currentOpen, nowSeconds);
    cachedCandles = rebuilt;
    log("one_history_rebuilt", {
      reason: "incremental_gap_exceeded_cache_window",
      historicalCandles: HISTORY_CANDLES
    });
    return cachedCandles;
  }

  // Start at the last cached candle so the exchange can revise its final OHLC
  // values, then append any newly opened candle(s). Duplicate open times replace.
  const incoming = await mexc.get15mCandles(
    PILOT_SYMBOL,
    lastCachedOpen,
    nowSeconds
  );
  const updated = mergeCandleHistory(cachedCandles, incoming, CACHE_LIMIT);
  if (!currentCandleFrom(updated, currentOpen)) {
    throw new Error("The incremental MEXC update did not include the current ONE candle.");
  }

  cachedCandles = updated;
  return cachedCandles;
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
