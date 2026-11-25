import test from "node:test";
import assert from "node:assert/strict";
import { runLocalHarsiScan } from "../src/local-scanner.js";

const INTERVAL_SECONDS = 900;
const CURRENT_OPEN = 1_800_000_000;
const NOW_MS = (CURRENT_OPEN + 60) * 1000;

function candle(symbol, openSeconds, index) {
  const base = 100 + index * 0.01;
  return {
    symbol,
    open_time: new Date(openSeconds * 1000).toISOString(),
    close_time: new Date((openSeconds + INTERVAL_SECONDS) * 1000).toISOString(),
    open_price: base,
    high_price: base + 1,
    low_price: base - 1,
    close_price: base + 0.25,
    volume: 10,
    amount: 1000
  };
}

test("local scanner reuses complete 2,000-candle cache and persists current HA", async () => {
  const symbol = "TEST_USDT";
  const history = Array.from({ length: 2000 }, (_, index) =>
    candle(symbol, CURRENT_OPEN - (2000 - index) * INTERVAL_SECONDS, index)
  );
  const current = candle(symbol, CURRENT_OPEN, 2000);
  const calls = { maxPrice: null, persist: [], pruneHistory: 0, pruneResults: 0 };
  const store = {
    async initialize() {},
    async pruneExpiredHarsi() { calls.pruneResults += 1; },
    async getHistoricalCandles() { return history; },
    async persistCurrentBatch(items) { calls.persist.push(...items); },
    async pruneCandleHistory() { calls.pruneHistory += 1; },
    async upsertCandles() { assert.fail("A complete cache must not be backfilled."); }
  };
  const mexc = {
    async getServerTimeMs() { return NOW_MS; },
    async getEligibleUsdtContracts(maxPrice) {
      calls.maxPrice = maxPrice;
      return [{ symbol, lastPrice: 2 }];
    },
    async getCandles(requestedSymbol, timeframe, start, end) {
      assert.equal(timeframe, "Min15");
      assert.equal(requestedSymbol, symbol);
      assert.equal(start, CURRENT_OPEN);
      assert.equal(end, Math.floor(NOW_MS / 1000));
      return [current];
    }
  };

  const summary = await runLocalHarsiScan({ mexc, store, maxPrice: 30 });

  assert.equal(calls.maxPrice, 30);
  assert.equal(calls.pruneResults, 1);
  assert.equal(calls.pruneHistory, 1);
  assert.equal(calls.persist.length, 1);
  assert.equal(summary.eligibleContracts, 1);
  assert.equal(summary.updatedContracts, 1);
  assert.equal(summary.failedContracts, 0);
  assert.equal(summary.historyCacheHits, 1);
  assert.equal(summary.historyBackfills, 0);
  assert.equal(summary.results[0].symbol, symbol);
  assert.equal(typeof summary.results[0].haClose, "number");
  assert.equal(typeof summary.results[0].vwapDaily, "number");
  assert.equal(typeof summary.results[0].vwapRolling, "number");
  assert.equal(typeof calls.persist[0].currentVwap.vwap_daily, "number");
  assert.equal(typeof calls.persist[0].currentVwap.vwap_rolling, "number");
});


test("local scanner supports the 1-hour timeframe with hourly candle spacing", async () => {
  const symbol = "TEST_USDT";
  const intervalSeconds = 3600;
  const currentOpen = 1_800_000_000;
  const nowMs = (currentOpen + 60) * 1000;
  const hourlyCandle = (openSeconds, index) => {
    const base = 100 + index * 0.01;
    return {
      symbol,
      open_time: new Date(openSeconds * 1000).toISOString(),
      close_time: new Date((openSeconds + intervalSeconds) * 1000).toISOString(),
      open_price: base, high_price: base + 1, low_price: base - 1,
      close_price: base + 0.25, volume: 10, amount: 1000
    };
  };
  const history = Array.from({ length: 2000 }, (_, index) =>
    hourlyCandle(currentOpen - (2000 - index) * intervalSeconds, index)
  );
  const current = hourlyCandle(currentOpen, 2000);
  let persistedTimeframe = null;
  const store = {
    async initialize() {},
    async pruneExpiredHarsi() {},
    async getHistoricalCandles(_symbol, _before, _limit, timeframe) {
      assert.equal(timeframe, "Min60");
      return history;
    },
    async persistCurrentBatch(items, timeframe) {
      persistedTimeframe = timeframe;
      assert.equal(items.length, 1);
    },
    async pruneCandleHistory(timeframe) { assert.equal(timeframe, "Min60"); },
    async upsertCandles() { assert.fail("A complete hourly cache must not be backfilled."); }
  };
  const mexc = {
    async getServerTimeMs() { return nowMs; },
    async getEligibleUsdtContracts() { return [{ symbol, lastPrice: 2 }]; },
    async getCandles(requestedSymbol, timeframe, start, end) {
      assert.equal(requestedSymbol, symbol);
      assert.equal(timeframe, "Min60");
      assert.equal(start, currentOpen);
      assert.equal(end, Math.floor(nowMs / 1000));
      return [current];
    }
  };

  const summary = await runLocalHarsiScan({ mexc, store, maxPrice: 30, nowMs, timeframe: "Min60" });
  assert.equal(persistedTimeframe, "Min60");
  assert.equal(summary.updatedContracts, 1);
  assert.equal(summary.failedContracts, 0);
  assert.equal(summary.historyCacheHits, 1);
  assert.equal(summary.results[0].timeframe, "Min60");
});

test("local scanner requires explicit maxPrice to preserve active eligibility settings", async () => {
  await assert.rejects(
    runLocalHarsiScan({ mexc: {}, store: {} }),
    /maxPrice/
  );
});


test("local scanner aborts before opening or writing when app is backgrounded", async () => {
  const controller = new AbortController();
  controller.abort();
  let initialized = false;
  const store = {
    async initialize() { initialized = true; }
  };
  const mexc = {
    async getServerTimeMs() { return NOW_MS; },
    async getEligibleUsdtContracts() { return []; },
    async getCandles() { return []; }
  };

  await assert.rejects(
    runLocalHarsiScan({
      mexc,
      store,
      maxPrice: 30,
      signal: controller.signal
    }),
    { name: "AbortError" }
  );
  assert.equal(initialized, false);
});
