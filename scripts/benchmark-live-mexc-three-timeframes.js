import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { MexcClient, createMexcRequestLimiter } from "../src/mexc-client.js";
import { runLocalHarsiScan } from "../src/local-scanner.js";

const TIMEFRAMES = ["Min5", "Min15", "Min60"];
const WORKERS_PER_TIMEFRAME = 8;
const MAX_PRICE = 10;
const CANDIDATE_SYMBOLS = [
  "XRP_USDT", "ADA_USDT", "DOGE_USDT", "TRX_USDT",
  "XLM_USDT", "ETC_USDT", "EOS_USDT", "IOTA_USDT",
  "NEO_USDT", "QTUM_USDT", "ONT_USDT", "ALGO_USDT",
  "ATOM_USDT", "VET_USDT", "ZIL_USDT", "THETA_USDT"
];

if (config.requestSpacingMs !== 125) {
  throw new Error(`Expected shared MEXC request spacing 125ms, got ${config.requestSpacingMs}ms`);
}

const originalFetch = globalThis.fetch;
let httpActive = 0;
let maxHttpActive = 0;
const requestStarts = [];
const httpStatuses = {};
const requestPaths = [];

globalThis.fetch = async (...args) => {
  httpActive += 1;
  maxHttpActive = Math.max(maxHttpActive, httpActive);
  requestStarts.push(performance.now());
  const requestUrl = String(args[0]);
  requestPaths.push(new URL(requestUrl).pathname);
  try {
    const response = await originalFetch(...args);
    httpStatuses[response.status] = (httpStatuses[response.status] || 0) + 1;
    return response;
  } finally {
    httpActive -= 1;
  }
};

const mexc = new MexcClient({ requestLimiter: createMexcRequestLimiter() });
let activeCandleCalls = 0;
let maxConcurrentCandleCalls = 0;
const originalGetCandles = mexc.getCandles.bind(mexc);
mexc.getCandles = async (...args) => {
  activeCandleCalls += 1;
  maxConcurrentCandleCalls = Math.max(maxConcurrentCandleCalls, activeCandleCalls);
  try {
    return await originalGetCandles(...args);
  } finally {
    activeCandleCalls -= 1;
  }
};

const storeHistory = new Map();
const store = {
  async initialize() {},
  async pruneExpiredHarsi() {},
  async getHistoricalCandles(symbol, _currentOpen, limit, timeframe) {
    return (storeHistory.get(`${timeframe}|${symbol}`) || []).slice(-limit);
  },
  async upsertCandles(candles, timeframe) {
    if (!candles.length) return;
    const symbol = candles[0].symbol;
    const key = `${timeframe}|${symbol}`;
    storeHistory.set(key, [...(storeHistory.get(key) || []), ...candles]
      .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
      .slice(-2000));
  },
  async persistCurrentBatch() { return []; },
  async pruneCandleHistory() {},
  async invalidateRollingFourHour() {}
};

const startedAt = new Date().toISOString();
const overallStart = performance.now();
const serverNowMs = await mexc.getServerTimeMs();
const eligible = await mexc.getEligibleUsdtContracts(MAX_PRICE);
const eligibleBySymbol = new Map(eligible.map((item) => [item.symbol, item]));
const preferred = CANDIDATE_SYMBOLS.map((symbol) => eligibleBySymbol.get(symbol)).filter(Boolean);
const selected = [...preferred, ...eligible.filter((item) => !preferred.some((chosen) => chosen.symbol === item.symbol))]
  .slice(0, WORKERS_PER_TIMEFRAME);

console.log(JSON.stringify({
  event: "live_mexc_preflight",
  startedAt,
  baseUrl: config.mexcBaseUrl,
  requestSpacingMs: config.requestSpacingMs,
  maxPrice: MAX_PRICE,
  eligibleUnderPriceCap: eligible.length,
  selectedSymbols: selected.map((item) => item.symbol),
  timeframes: TIMEFRAMES,
  workersPerTimeframe: WORKERS_PER_TIMEFRAME,
  totalLogicalWorkers: TIMEFRAMES.length * WORKERS_PER_TIMEFRAME
}));

if (selected.length !== WORKERS_PER_TIMEFRAME) {
  throw new Error(`Need 8 eligible contracts for a valid 24-worker test; found ${selected.length}`);
}

const dailyVwapCache = new Map();
const summaries = await Promise.all(TIMEFRAMES.map(async (timeframe) => {
  const progress = { processed: 0, total: selected.length };
  const summary = await runLocalHarsiScan({
    mexc,
    store,
    maxPrice: MAX_PRICE,
    nowMs: serverNowMs,
    eligibleContracts: selected,
    timeframe,
    workerCount: WORKERS_PER_TIMEFRAME,
    dailyVwapCache,
    onProgress(update) {
      progress.processed = update.processed;
      progress.total = update.total;
    }
  });
  return {
    timeframe,
    workers: WORKERS_PER_TIMEFRAME,
    eligible: summary.eligibleContracts,
    updated: summary.updatedContracts,
    failed: summary.failedContracts,
    skipped: summary.skippedContracts,
    errorCounts: summary.errorCounts,
    errors: summary.errors.slice(0, 5),
    historyCacheHits: summary.historyCacheHits,
    historyBackfills: summary.historyBackfills,
    progress
  };
}));

const elapsedMs = Math.round(performance.now() - overallStart);
const spacingGaps = requestStarts.slice(1).map((value, index) => value - requestStarts[index]);
const minSpacingMs = spacingGaps.length ? Math.round(Math.min(...spacingGaps)) : null;
const report = {
  event: "live_mexc_three_timeframe_result",
  mode: "LIVE_MEXC_PUBLIC_FUTURES_KLINE",
  startedAt,
  completedAt: new Date().toISOString(),
  elapsedMs,
  requestSpacingMs: config.requestSpacingMs,
  minObservedRequestSpacingMs: minSpacingMs,
  httpRequests: requestStarts.length,
  httpStatuses,
  maxInFlightHttpRequests: maxHttpActive,
  maxConcurrentCandleOperations: maxConcurrentCandleCalls,
  timeframes: summaries,
  totals: {
    eligible: summaries.reduce((sum, item) => sum + item.eligible, 0),
    updated: summaries.reduce((sum, item) => sum + item.updated, 0),
    failed: summaries.reduce((sum, item) => sum + item.failed, 0),
    skipped: summaries.reduce((sum, item) => sum + item.skipped, 0)
  }
};
console.log(JSON.stringify(report, null, 2));

const rateLimitErrors = summaries.reduce((sum, item) => sum + (item.errorCounts?.mexc_limit || 0), 0);
const badHttpStatuses = Object.keys(httpStatuses).some((status) => Number(status) === 429);
const spacingViolation = minSpacingMs !== null && minSpacingMs < 115;
if (rateLimitErrors > 0 || badHttpStatuses || spacingViolation
    || summaries.some((item) => item.failed > 0 || item.skipped > 0 || item.updated !== WORKERS_PER_TIMEFRAME)) {
  process.exitCode = 1;
}
