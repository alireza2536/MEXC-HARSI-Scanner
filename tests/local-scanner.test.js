import test from "node:test";
import assert from "node:assert/strict";
import { runLocalHarsiScan } from "../src/local-scanner.js";
import { aggregateRollingFourHourCandles } from "../src/vwap.js";

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
  assert.equal(typeof calls.persist[0].currentVwap.vwap_daily, "number");
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
      return [
        { symbol, open_time: "2026-11-25T20:00:00.000Z", close_price: 99, vwap_daily: 100 },
        { symbol, open_time: "2026-11-26T00:00:00.000Z", close_price: 101, vwap_daily: 100 }
      ];
    },
    async pruneCandleHistory(timeframe) { assert.equal(timeframe, "Min60"); },
    async upsertCandles() { assert.fail("A complete hourly cache must not be backfilled."); }
  };
  const mexc = {
    async getServerTimeMs() { return nowMs; },
    async getEligibleUsdtContracts() { return [{ symbol, lastPrice: 2 }]; },
    async getCandles(requestedSymbol, timeframe, start, end) {
      assert.equal(requestedSymbol, symbol);
      if (timeframe === "Min15") {
        const utcDayStart = Math.floor(currentOpen / 86400) * 86400;
        assert.equal(start, utcDayStart);
        assert.equal(end, Math.floor(nowMs / 1000));
        return [hourlyCandle(utcDayStart, 0)];
      }
      assert.equal(start, currentOpen);
      assert.equal(end, Math.floor(nowMs / 1000));
      assert.equal(timeframe, "Min60");
      return [current];
    }
  };

  const summary = await runLocalHarsiScan({ mexc, store, maxPrice: 30, nowMs, timeframe: "Min60" });
  assert.equal(persistedTimeframe, "Min60");
  assert.equal(summary.updatedContracts, 1);
  assert.equal(summary.failedContracts, 0);
  assert.equal(summary.historyCacheHits, 1);
  assert.equal(summary.historyBackfills, 0);
  assert.equal(summary.results[0].timeframe, "Min60");
  const fourHour = summary.results.find((row) => row.timeframe === "Min240");
  assert.ok(fourHour);
  assert.equal(fourHour.previousCandleClose, 99);
  assert.equal(fourHour.candleClose, 101);
  assert.equal(fourHour.vwapDaily, 100);
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


test("local scanner supports the 5-minute timeframe and retains daily VWAP calculation", async () => {
  const symbol = "TEST_USDT";
  const currentOpen = 1_800_000_000;
  const nowMs = (currentOpen + 60) * 1000;
  const makeCandle = (openSeconds, index, intervalSeconds) => {
    const base = 100 + index * 0.01;
    return {
      symbol,
      open_time: new Date(openSeconds * 1000).toISOString(),
      close_time: new Date((openSeconds + intervalSeconds) * 1000).toISOString(),
      open_price: base, high_price: base + 1, low_price: base - 1,
      close_price: base + 0.25, volume: 10, amount: 1000
    };
  };
  const history5m = Array.from({ length: 2000 }, (_, index) =>
    makeCandle(currentOpen - (2000 - index) * 300, index, 300)
  );
  const current5m = makeCandle(currentOpen, 2000, 300);
  const store = {
    async initialize() {}, async pruneExpiredHarsi() {},
    async getHistoricalCandles(_symbol, _before, _limit, timeframe) {
      assert.equal(timeframe, "Min5");
      return history5m;
    },
    async persistCurrentBatch(items, timeframe) {
      assert.equal(timeframe, "Min5");
      assert.equal(items.length, 1);
      assert.equal(typeof items[0].currentVwap.vwap_daily, "number");
    },
    async pruneCandleHistory(timeframe) { assert.equal(timeframe, "Min5"); },
    async upsertCandles() { assert.fail("Complete cache must not be backfilled."); }
  };
  const mexc = {
    async getServerTimeMs() { return nowMs; },
    async getEligibleUsdtContracts() { return [{ symbol, lastPrice: 2 }]; },
    async getCandles(requestedSymbol, timeframe, start, end) {
      assert.equal(requestedSymbol, symbol);
      if (timeframe === "Min15") {
        const utcDayStart = Math.floor(currentOpen / 86400) * 86400;
        assert.equal(start, utcDayStart);
        assert.equal(end, Math.floor(nowMs / 1000));
        return [makeCandle(utcDayStart, 0, 900)];
      }
      assert.equal(start, currentOpen);
      assert.equal(end, Math.floor(nowMs / 1000));
      assert.equal(timeframe, "Min5");
      return [current5m];
    }
  };
  const summary = await runLocalHarsiScan({ mexc, store, maxPrice: 30, nowMs, timeframe: "Min5" });
  assert.equal(summary.updatedContracts, 1);
  assert.equal(summary.failedContracts, 0);
  assert.equal(summary.historyCacheHits, 1);
  assert.equal(summary.results[0].timeframe, "Min5");
});


test("rolling 4-hour aggregation builds two overlapping-window source candles", () => {
  const start = Date.parse("2026-11-26T00:00:00.000Z");
  const hourly = Array.from({ length: 8 }, (_, index) => ({
    symbol: "BTC_USDT",
    open_time: new Date(start + index * 3600000).toISOString(),
    close_time: new Date(start + (index + 1) * 3600000).toISOString(),
    open_price: 100 + index,
    high_price: 105 + index,
    low_price: 95 + index,
    close_price: 102 + index,
    volume: 10 + index,
    amount: 1000 + index
  }));
  const first = aggregateRollingFourHourCandles(hourly);
  assert.equal(first.length, 2);
  assert.equal(first[0].open_time, hourly[0].open_time);
  assert.equal(first[0].close_time, hourly[3].close_time);
  assert.equal(first[0].open_price, hourly[0].open_price);
  assert.equal(first[0].high_price, hourly[3].high_price);
  assert.equal(first[0].low_price, hourly[0].low_price);
  assert.equal(first[0].close_price, hourly[3].close_price);
  assert.equal(first[0].volume, 46);
  assert.equal(first[1].open_time, hourly[4].open_time);
  assert.equal(first[1].close_time, hourly[7].close_time);

  const shifted = aggregateRollingFourHourCandles(hourly.slice(1).concat([{
    ...hourly[7],
    open_time: new Date(start + 8 * 3600000).toISOString(),
    close_time: new Date(start + 9 * 3600000).toISOString(),
    open_price: 108, high_price: 113, low_price: 103, close_price: 110
  }]));
  assert.equal(shifted.length, 2);
  assert.equal(shifted[0].open_time, hourly[1].open_time);
  assert.equal(shifted[1].open_time, hourly[5].open_time);
});

test("rolling 4-hour aggregation rejects missing or non-consecutive hourly candles", () => {
  const start = Date.parse("2026-11-26T00:00:00.000Z");
  const hourly = Array.from({ length: 8 }, (_, index) => ({
    symbol: "BTC_USDT",
    open_time: new Date(start + index * 3600000).toISOString(),
    close_time: new Date(start + (index + 1) * 3600000).toISOString(),
    open_price: 100, high_price: 101, low_price: 99, close_price: 100,
    volume: 1, amount: 100
  }));
  assert.deepEqual(aggregateRollingFourHourCandles(hourly.slice(0, 7)), []);
  const gap = hourly.map((candle, index) => index === 4
    ? { ...candle, open_time: new Date(start + 5 * 3600000).toISOString() }
    : candle);
  assert.deepEqual(aggregateRollingFourHourCandles(gap), []);
});
