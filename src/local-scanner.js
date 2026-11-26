import { calculateHarsi } from "./harsi.js";
import { hasCompleteCandleWindow } from "./candle-history-cache.js";
import { calculateDailyVwap } from "./vwap.js";

export async function getSharedDailyVwap({ mexc, symbol, timeframe, candles, serverNowMs, nowSeconds, cache = new Map() }) {
  const utcDayStart = new Date(serverNowMs);
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const cacheKey = `${symbol}|${utcDayStart.toISOString().slice(0, 10)}`;
  if (timeframe === "Min15") {
    const value = calculateDailyVwap(candles, serverNowMs);
    cache.set(cacheKey, Promise.resolve(value));
    return value;
  }
  if (!cache.has(cacheKey)) {
    const request = (async () => {
      const dailyCandles = await mexc.getCandles(symbol, "Min15", Math.floor(utcDayStart.getTime() / 1000), nowSeconds);
      return calculateDailyVwap(dailyCandles, serverNowMs);
    })();
    cache.set(cacheKey, request);
    request.catch(() => { if (cache.get(cacheKey) === request) cache.delete(cacheKey); });
  }
  return cache.get(cacheKey);
}

const TIMEFRAME_SECONDS = Object.freeze({ Min5: 300, Min15: 900, Min60: 3600 });
const HISTORY_CANDLES = 2000;
const PERSISTENCE_BATCH_SIZE = 10;

function currentCandleFrom(candles, currentOpen) {
  return candles.find((candle) => Date.parse(candle.open_time) === currentOpen * 1000);
}

function log(event, details = {}) {
  console.info(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
}

async function getHistory(store, mexc, symbol, currentOpen, signal, timeframe, candleSeconds) {
  const cached = await store.getHistoricalCandles(
    symbol,
    new Date(currentOpen * 1000).toISOString(),
    HISTORY_CANDLES,
    timeframe
  );
  const expectedLastOpen = (currentOpen - candleSeconds) * 1000;

  if (hasCompleteCandleWindow(cached, HISTORY_CANDLES, expectedLastOpen, candleSeconds * 1000)) {
    return { candles: cached, cacheHit: true };
  }

  const response = await mexc.getCandles(
    symbol,
    timeframe,
    currentOpen - HISTORY_CANDLES * candleSeconds,
    currentOpen - 1
  );
  if (signal?.aborted) throw new DOMException("Scan was stopped.", "AbortError");
  const historical = response
    .filter((candle) => Date.parse(candle.open_time) < currentOpen * 1000)
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
    .slice(-HISTORY_CANDLES);

  if (historical.length !== HISTORY_CANDLES) {
    throw new Error(
      `History is incomplete: expected ${HISTORY_CANDLES} prior candles, received ${historical.length}`
    );
  }
  await store.upsertCandles(historical, timeframe);
  return { candles: historical, cacheHit: false };
}

/**
 * Local scanner. The Android caller owns scan lifecycle and keeps a native
 * foreground service active for the duration of each user-started scan.
 */
export async function runLocalHarsiScan({ mexc, store, maxPrice, nowMs, onProgress, signal, timeframe = "Min15", workerCount = 5, dailyVwapCache = new Map() } = {}) {
  if (!mexc || !store) throw new TypeError("MEXC client and local store are required.");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    throw new TypeError("The current scanner maxPrice setting must be provided.");
  }
  if (typeof mexc.getServerTimeMs !== "function"
      || typeof mexc.getEligibleUsdtContracts !== "function"
      || typeof mexc.getCandles !== "function") {
    throw new TypeError("The MEXC client does not implement the scanner interface.");
  }

  const candleSeconds = TIMEFRAME_SECONDS[timeframe];
  if (!candleSeconds) throw new TypeError(`Unsupported timeframe: ${timeframe}`);

  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Scan was stopped.", "AbortError");
  };
  throwIfAborted();
  await store.initialize();
  await store.pruneExpiredHarsi(new Date(), timeframe);
  throwIfAborted();

  const serverNowMs = Number.isFinite(nowMs) ? nowMs : await mexc.getServerTimeMs();
  throwIfAborted();
  const nowSeconds = Math.floor(serverNowMs / 1000);
  const currentOpen = Math.floor(nowSeconds / candleSeconds) * candleSeconds;
  const contracts = await mexc.getEligibleUsdtContracts(maxPrice);
  throwIfAborted();

  log("local_scan_started", {
    timeframe,
    eligibleContracts: contracts.length,
    historicalCandles: HISTORY_CANDLES,
    currentCandleOpen: currentOpen
  });

  let nextIndex = 0;
  let historyCacheHits = 0;
  let historyBackfills = 0;
  let failedContracts = 0;
  let updatedContracts = 0;
  let processedContracts = 0;
  const pending = [];
  const results = [];
  let persistQueue = Promise.resolve();

  function publishProgress(symbol) {
    onProgress?.({
      processed: processedContracts,
      total: contracts.length,
      remaining: Math.max(0, contracts.length - processedContracts),
      updated: updatedContracts,
      failed: failedContracts,
      symbol,
      results: results.slice()
    });
  }

  function queuePersistence(batch) {
    persistQueue = persistQueue.then(async () => {
      try {
        const rollingFourHourRows = await store.persistCurrentBatch(batch, timeframe);
        updatedContracts += batch.length;
        for (const item of batch) {
          results.push({
            timeframe,
            symbol: item.contract.symbol,
            lastPrice: item.contract.lastPrice,
            candleClose: item.current.close_price,
            previousCandleClose: item.previous.close_price,
            haClose: item.currentHarsi.ha_close,
            vwapDaily: item.currentVwap.vwap_daily,
            candleOpenTime: item.current.open_time
          });
          if (timeframe === "Min60" && Array.isArray(rollingFourHourRows)) {
            const pair = rollingFourHourRows
              .filter((row) => row.symbol === item.contract.symbol)
              .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
            if (pair.length === 2) {
              results.push({
                timeframe: "Min240",
                symbol: item.contract.symbol,
                candleClose: pair[1].close_price,
                previousCandleClose: pair[0].close_price,
                vwapDaily: pair[1].vwap_daily,
                candleOpenTime: pair[1].open_time
              });
            }
          }
        }
      } catch (error) {
        failedContracts += batch.length;
        for (const item of batch) {
          log("local_persistence_failed", { symbol: item.contract.symbol, error: error.message });
        }
      }
    });
    return persistQueue;
  }

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      if (index >= contracts.length) return;
      const contract = contracts[index];
      try {
        const history = await getHistory(store, mexc, contract.symbol, currentOpen, signal, timeframe, candleSeconds);
        throwIfAborted();
        if (history.cacheHit) historyCacheHits += 1;
        else historyBackfills += 1;

        const currentResponse = await mexc.getCandles(
          contract.symbol,
          timeframe,
          currentOpen,
          nowSeconds
        );
        throwIfAborted();
        const current = currentCandleFrom(currentResponse, currentOpen);
        if (!current) throw new Error(`MEXC did not return the currently forming ${timeframe} candle.`);

        const candlesForIndicators = [...history.candles, current];
        const currentHarsi = calculateHarsi(candlesForIndicators)
          .find((row) => row.open_time === current.open_time);
        if (!currentHarsi) throw new Error("HARSI value is not ready for the current candle.");

        // All timeframes compare their current candle close against the same 15m-based daily VWAP.
        const currentVwap = await getSharedDailyVwap({
          mexc, symbol: contract.symbol, timeframe, candles: candlesForIndicators,
          serverNowMs, nowSeconds, cache: dailyVwapCache
        });

        const previous = history.candles.at(-1);
        if (!previous) throw new Error(`Previous ${timeframe} candle is unavailable for VWAP cross detection.`);
        pending.push({ contract, current, previous, currentHarsi, currentVwap });
        if (pending.length >= PERSISTENCE_BATCH_SIZE) {
          const batch = pending.splice(0, PERSISTENCE_BATCH_SIZE);
          await queuePersistence(batch);
        }
      } catch (error) {
        if (signal?.aborted || error.name === "AbortError") return;
        failedContracts += 1;
        log("local_contract_failed", { symbol: contract.symbol, error: error.message });
      }
      processedContracts += 1;
      publishProgress(contract.symbol);
    }
  }

  const concurrency = Math.max(1, Math.min(5, Math.floor(Number(workerCount) || 1)));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, contracts.length) }, () => worker())
  );
  throwIfAborted();

  throwIfAborted();
  if (pending.length) {
    const batch = pending.splice(0, pending.length);
    await queuePersistence(batch);
  }
  await persistQueue;
  throwIfAborted();
  publishProgress(null);

  // Do not keep the user-facing scan state locked while SQLite performs
  // the potentially expensive historical-candle cleanup. All writes remain
  // serialized by the store; cleanup failures are logged for diagnosis.
  void store.pruneCandleHistory(timeframe).catch((error) => {
    log("local_candle_prune_failed", { timeframe, error: error?.message || String(error) });
  });
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
  log("local_scan_completed", {
    timeframe,
    eligibleContracts: summary.eligibleContracts,
    updatedContracts: summary.updatedContracts,
    failedContracts: summary.failedContracts,
    historyCacheHits: summary.historyCacheHits,
    historyBackfills: summary.historyBackfills,
    candleOpenTime: summary.candleOpenTime
  });
  return summary;
}
