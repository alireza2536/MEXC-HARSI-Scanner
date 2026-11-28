import { performance } from "node:perf_hooks";
import { runLocalHarsiScan } from "../src/local-scanner.js";

const WORKERS = [10, 15, 25];
const REQUEST_SPACINGS_MS = [125, 100];
const REPEATS = 2;
const CONTRACT_COUNT = 12;
const NETWORK_LATENCY_MS = 20;
const HOUR_MS = 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const currentOpen = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
const nowSeconds = Math.floor((nowMs + 30 * 60 * 1000) / 1000);
const dayStartMs = new Date(nowMs).setUTCHours(0, 0, 0, 0);

function candle(symbol, openMs, index) {
  const base = 1 + index * 0.0002 + Math.sin(index / 13) * 0.08;
  return {
    symbol,
    open_time: new Date(openMs).toISOString(),
    close_time: new Date(openMs + HOUR_MS - 1).toISOString(),
    open_price: base,
    high_price: base + 0.025,
    low_price: base - 0.025,
    close_price: base + Math.sin(index / 7) * 0.012,
    volume: 100 + (index % 17)
  };
}

const history = Array.from({ length: 2000 }, (_, index) =>
  candle("BENCH", currentOpen - (2000 - index) * HOUR_MS, index)
);
const dailyCandles = [];
for (let time = dayStartMs, index = 0; time <= nowMs; time += 15 * 60 * 1000, index += 1) {
  const c = candle("BENCH", time, index + 3000);
  dailyCandles.push({ ...c, close_time: new Date(time + 15 * 60 * 1000 - 1).toISOString() });
}
const contracts = Array.from({ length: CONTRACT_COUNT }, (_, index) => ({
  symbol: `BENCH${String(index + 1).padStart(3, "0")}_USDT`,
  lastPrice: 1 + index / 100
}));

function createRateLimitedMockMexc(requestSpacingMs) {
  let nextRequestAt = 0;
  let requestCount = 0;
  async function requestSlot() {
    const current = performance.now();
    const slot = Math.max(current, nextRequestAt);
    nextRequestAt = slot + requestSpacingMs;
    await sleep(Math.max(0, slot - current));
    requestCount += 1;
    await sleep(NETWORK_LATENCY_MS);
  }
  return {
    get requestCount() { return requestCount; },
    async getServerTimeMs() { return nowMs + 30 * 60 * 1000; },
    async getEligibleUsdtContracts() { return contracts; },
    async getCandles(symbol, timeframe) {
      await requestSlot();
      if (timeframe === "Min15") {
        return dailyCandles.map((item) => ({ ...item, symbol }));
      }
      if (timeframe === "Min60") {
        return [candle(symbol, currentOpen, 2001)];
      }
      throw new Error(`Unexpected benchmark timeframe: ${timeframe}`);
    }
  };
}

function createWarmCacheStore() {
  return {
    async initialize() {},
    async pruneExpiredHarsi() {},
    async getHistoricalCandles() { return history; },
    async persistCurrentBatch() { await sleep(2); return []; },
    async pruneCandleHistory() {},
  };
}

async function runOne(workerCount, requestSpacingMs) {
  const mexc = createRateLimitedMockMexc(requestSpacingMs);
  const store = createWarmCacheStore();
  const started = performance.now();
  const summary = await runLocalHarsiScan({
    mexc,
    store,
    maxPrice: 10,
    nowMs: nowMs + 30 * 60 * 1000,
    eligibleContracts: contracts,
    timeframe: "Min60",
    workerCount,
    dailyVwapCache: new Map()
  });
  const elapsedMs = performance.now() - started;
  return {
    requestSpacingMs,
    workerCount,
    elapsedMs: Math.round(elapsedMs),
    contracts: summary.eligibleContracts,
    updated: summary.updatedContracts,
    failed: summary.failedContracts,
    historyCacheHits: summary.historyCacheHits,
    historyBackfills: summary.historyBackfills,
    requests: mexc.requestCount,
    contractsPerMinute: Number((summary.updatedContracts / (elapsedMs / 60000)).toFixed(2))
  };
}

const results = [];
for (const requestSpacingMs of REQUEST_SPACINGS_MS) {
  for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
    for (const workerCount of WORKERS) {
      const result = await runOne(workerCount, requestSpacingMs);
      results.push({ repeat, requestSpacingMs, ...result });
      console.log(JSON.stringify({ event: "benchmark_result", repeat, requestSpacingMs, ...result }));
    }
  }
}

const grouped = REQUEST_SPACINGS_MS.flatMap((requestSpacingMs) => WORKERS.map((workerCount) => {
  const rows = results.filter((item) => item.requestSpacingMs === requestSpacingMs && item.workerCount === workerCount);
  const mean = (key) => Math.round(rows.reduce((sum, item) => sum + item[key], 0) / rows.length);
  return {
    requestSpacingMs,
    workerCount,
    avgElapsedMs: mean("elapsedMs"),
    avgContractsPerMinute: Number((rows.reduce((sum, item) => sum + item.contractsPerMinute, 0) / rows.length).toFixed(2)),
    totalUpdated: rows.reduce((sum, item) => sum + item.updated, 0),
    totalFailed: rows.reduce((sum, item) => sum + item.failed, 0),
    cacheHits: rows.reduce((sum, item) => sum + item.historyCacheHits, 0),
    backfills: rows.reduce((sum, item) => sum + item.historyBackfills, 0)
  };
}));

console.log(JSON.stringify({
  event: "benchmark_summary",
  mode: "synthetic-rate-limited-warm-cache",
  timeframe: "Min60",
  repeats: REPEATS,
  contractCount: CONTRACT_COUNT,
  testedRequestSpacingMs: REQUEST_SPACINGS_MS,
  simulatedNetworkLatencyMs: NETWORK_LATENCY_MS,
  results: grouped
}, null, 2));
if (results.some((item) => item.failed > 0 || item.updated !== CONTRACT_COUNT)) {
  process.exitCode = 1;
}
