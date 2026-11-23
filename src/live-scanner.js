import pg from "pg";
import { config, validateConfig } from "./config.js";
import { MexcClient } from "./mexc-client.js";
import { calculateHarsi } from "./harsi.js";
import { mergeCandleHistory } from "./candle-history-cache.js";

const { Pool } = pg;
const CANDLE_SECONDS = 15 * 60;
const HISTORY_CANDLES = 2000;
const CACHE_LIMIT = HISTORY_CANDLES + 1;
const PILOT_SYMBOL = "AKE_USDT";

// This cache lives only in the running server process. It is intentionally
// not written to the database and is rebuilt after a process restart.
let cachedCandles = [];

const log = (event, details = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
};

function currentCandleFrom(candles, currentOpen) {
  return candles.find((candle) => Date.parse(candle.open_time) === currentOpen * 1000);
}

async function bootstrapAkeHistory(mexc, currentOpen, nowSeconds) {
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
      `AKE history is incomplete: expected ${HISTORY_CANDLES} prior candles, received ${historical.length}`
    );
  }

  const currentResponse = await mexc.get15mCandles(
    PILOT_SYMBOL,
    currentOpen,
    nowSeconds
  );
  const current = currentCandleFrom(currentResponse, currentOpen);
  if (!current) {
    throw new Error("MEXC did not return the currently forming AKE candle.");
  }

  return mergeCandleHistory(historical, [current], CACHE_LIMIT);
}

async function getAkeCandles(mexc, currentOpen, nowSeconds) {
  if (cachedCandles.length === 0) {
    const initial = await bootstrapAkeHistory(mexc, currentOpen, nowSeconds);
    cachedCandles = initial;
    log("ake_history_initialized", {
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
    const rebuilt = await bootstrapAkeHistory(mexc, currentOpen, nowSeconds);
    cachedCandles = rebuilt;
    log("ake_history_rebuilt", {
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
    throw new Error("The incremental MEXC update did not include the current AKE candle.");
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

    log("live_scan_started", {
      timeframe: "Min15",
      pilotSymbol: PILOT_SYMBOL,
      historicalCandles: HISTORY_CANDLES,
      currentCandleOpen: currentOpen
    });

    const candles = await getAkeCandles(mexc, currentOpen, nowSeconds);
    const current = currentCandleFrom(candles, currentOpen);
    if (!current) throw new Error("Current AKE candle is missing from the in-memory history.");

    const harsiRows = calculateHarsi(candles);
    const currentHarsi = harsiRows.find((row) => row.open_time === current.open_time);
    if (!currentHarsi) {
      throw new Error("HARSI value is not ready for the current AKE candle.");
    }

    // Preserve the existing database behavior for the current candle/result only.
    // The 2,000-candle calculation history remains in process memory only.
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

    const summary = {
      eligibleContracts: 1,
      updatedContracts: 1,
      failedContracts: 0,
      candleOpenTime: new Date(currentOpen * 1000).toISOString(),
      completedAt: new Date().toISOString(),
      results: [{
        symbol: PILOT_SYMBOL,
        lastPrice: current.close_price,
        candleClose: current.close_price,
        haClose: currentHarsi.ha_close,
        candleOpenTime: current.open_time
      }]
    };

    log("live_scan_completed", {
      pilotSymbol: PILOT_SYMBOL,
      historicalCandlesInMemory: HISTORY_CANDLES,
      updatedContracts: 1,
      failedContracts: 0,
      candleOpenTime: summary.candleOpenTime,
      haClose: currentHarsi.ha_close
    });
    return summary;
  } finally {
    await pool.end();
  }
}
