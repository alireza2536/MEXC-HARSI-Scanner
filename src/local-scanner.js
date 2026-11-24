import { calculateHarsi } from "./harsi.js";
import { hasCompleteCandleWindow } from "./candle-history-cache.js";

const CANDLE_SECONDS = 15 * 60;
const CANDLE_MS = CANDLE_SECONDS * 1000;
const HISTORY_CANDLES = 2000;
const PERSISTENCE_BATCH_SIZE = 50;

function currentCandleFrom(candles, currentOpen) {
  return candles.find((candle) => Date.parse(candle.open_time) === currentOpen * 1000);
}

function log(event, details = {}) {
  console.info(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
}

async function getHistory(store, mexc, symbol, currentOpen) {
  const cached = await store.getHistoricalCandles(
    symbol,
    new Date(currentOpen * 1000).toISOString(),
    HISTORY_CANDLES
  );
  const expectedLastOpen = (currentOpen - CANDLE_SECONDS) * 1000;

  if (hasCompleteCandleWindow(cached, HISTORY_CANDLES, expectedLastOpen, CANDLE_MS)) {
    return { candles: cached, cacheHit: true };
  }

  const response = await mexc.get15mCandles(
    symbol,
    currentOpen - HISTORY_CANDLES * CANDLE_SECONDS,
    currentOpen - 1
  );
  const historical = response
    .filter((candle) => Date.parse(candle.open_time) < currentOpen * 1000)
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
    .slice(-HISTORY_CANDLES);

  if (historical.length !== HISTORY_CANDLES) {
    throw new Error(
      `History is incomplete: expected ${HISTORY_CANDLES} prior candles, received ${historical.length}`
    );
  }
  await store.upsertCandles(historical);
  return { candles: historical, cacheHit: false };
}

/**
 * Foreground-only local scanner. The caller owns app lifecycle and must call
 * this function only while the Android app is active.
 */
export async function runLocalHarsiScan({ mexc, store, maxPrice, nowMs, onProgress } = {}) {
  if (!mexc || !store) throw new TypeError("MEXC client and local store are required.");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    throw new TypeError("The current scanner maxPrice setting must be provided.");
  }
  if (typeof mexc.getServerTimeMs !== "function"
      || typeof mexc.getEligibleUsdtContracts !== "function"
      || typeof mexc.get15mCandles !== "function") {
    throw new TypeError("The MEXC client does not implement the scanner interface.");
  }

  await store.initialize();
  await store.pruneExpiredHarsi();

  const serverNowMs = Number.isFinite(nowMs) ? nowMs : await mexc.getServerTimeMs();
  const nowSeconds = Math.floor(serverNowMs / 1000);
  const currentOpen = Math.floor(nowSeconds / CANDLE_SECONDS) * CANDLE_SECONDS;
  const contracts = await mexc.getEligibleUsdtContracts(maxPrice);

  log("local_scan_started", {
    timeframe: "Min15",
    eligibleContracts: contracts.length,
    historicalCandles: HISTORY_CANDLES,
    currentCandleOpen: currentOpen
  });

  let nextIndex = 0;
  let historyCacheHits = 0;
  let historyBackfills = 0;
  let failedContracts = 0;
  let updatedContracts = 0;
  const pending = [];
  const results = [];

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= contracts.length) return;
      const contract = contracts[index];
      try {
        const history = await getHistory(store, mexc, contract.symbol, currentOpen);
        if (history.cacheHit) historyCacheHits += 1;
        else historyBackfills += 1;

        const currentResponse = await mexc.get15mCandles(
          contract.symbol,
          currentOpen,
          nowSeconds
        );
        const current = currentCandleFrom(currentResponse, currentOpen);
        if (!current) throw new Error("MEXC did not return the currently forming 15m candle.");

        const currentHarsi = calculateHarsi([...history.candles, current])
          .find((row) => row.open_time === current.open_time);
        if (!currentHarsi) throw new Error("HARSI value is not ready for the current candle.");

        pending.push({ contract, current, currentHarsi });
      } catch (error) {
        failedContracts += 1;
        log("local_contract_failed", { symbol: contract.symbol, error: error.message });
      }
      onProgress?.({
        processed: index + 1,
        total: contracts.length,
        symbol: contract.symbol
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(5, contracts.length) }, () => worker())
  );

  for (let offset = 0; offset < pending.length; offset += PERSISTENCE_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + PERSISTENCE_BATCH_SIZE);
    try {
      await store.persistCurrentBatch(batch);
      updatedContracts += batch.length;
      for (const item of batch) {
        results.push({
          symbol: item.contract.symbol,
          lastPrice: item.contract.lastPrice,
          candleClose: item.current.close_price,
          haClose: item.currentHarsi.ha_close,
          candleOpenTime: item.current.open_time
        });
      }
    } catch (error) {
      failedContracts += batch.length;
      for (const item of batch) {
        log("local_persistence_failed", { symbol: item.contract.symbol, error: error.message });
      }
    }
  }

  await store.pruneCandleHistory();
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
    timeframe: "Min15",
    eligibleContracts: summary.eligibleContracts,
    updatedContracts: summary.updatedContracts,
    failedContracts: summary.failedContracts,
    historyCacheHits: summary.historyCacheHits,
    historyBackfills: summary.historyBackfills,
    candleOpenTime: summary.candleOpenTime
  });
  return summary;
}
