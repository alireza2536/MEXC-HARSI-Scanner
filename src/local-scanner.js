import { calculateHarsi } from "./harsi.js";
import { hasCompleteCandleWindow } from "./candle-history-cache.js";
import { calculateDailyVwap } from "./vwap.js";

const TIMEFRAME_SECONDS = Object.freeze({ Min5: 300, Min55: 900, Min60: 3600 });
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
export async function runLocalHarsiScan({ mexc, store, maxPrice, nowMs, onProgress, signal, timeframe = "Min55", workerCount = 5 } = {}) {
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
        await store.persistCurrentBatch(batch, timeframe);
        updatedContracts += batch.length;
        for (const item of batch) {
          results.push({
            timeframe,
            symbol: item.contract.symbol,
            lastPrice: item.contract.lastPrice,
            candleClose: item.current.close_price,
            haClose: item.currentHarsi.ha_close,
            vwapDaily: item.currentVwap.vwap_daily,
            candleOpenTime: item.current.open_time
          });
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

        let dailyCandles = candlesForIndicators;
        if (timeframe !== "Min55") {
          const dailyCandleSeconds = TIMEFRAME_SECONDS.Min55;
          const dailyCurrentOpen = Math.floor(nowSeconds / dailyCandleSeconds) * dailyCandleSeconds;
          const dailyHistory = await getHistory(
            store, mexc, contract.symbol, dailyCurrentOpen, signal, "Min55", dailyCandleSeconds
          );
          if (dailyHistory.cacheHit) historyCacheHits += 1;
          else historyBackfills += 1;
          const dailyCurrentResponse = await mexc.getCandles(
            contract.symbol, "Min55", dailyCurrentOpen, nowSeconds
          );
          throwIfAborted();
          const dailyCurrent = currentCandleFrom(dailyCurrentResponse, dailyCurrentOpen);
          if (!dailyCurrent) throw new Error("MEXC did not return the currently forming Min55 candle for daily VWAP.");
          dailyCandles = [...dailyHistory.candles, dailyCurrent];
        }
        const currentVwap = calculateDailyVwap(dailyCandles, serverNowMs);

        pending.push({ contract, current, currentHarsi, currentVwap });
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
