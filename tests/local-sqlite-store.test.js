import test from "node:test";
import assert from "node:assert/strict";
import { createLocalSqliteStore, LOCAL_STORE_LIMITS } from "../src/local-sqlite-store.js";

function fakeConnection() {
  return {
    executed: [],
    queries: [],
    runs: [],
    sets: [],
    async execute(statement) { this.executed.push(statement); },
    async query(statement, values) {
      this.queries.push({ statement, values });
      return { values: [] };
    },
    async run(statement, values) {
      this.runs.push({ statement, values });
      return { changes: { changes: 1 } };
    },
    async executeSet(set, transaction) {
      this.sets.push({ set, transaction });
      return { changes: { changes: set.length } };
    }
  };
}

test("local SQLite store initializes schema and commits candle/HA rows atomically", async () => {
  const db = fakeConnection();
  const store = createLocalSqliteStore(db);
  await store.initialize();
  assert.equal(db.executed.length, 14);
  assert.match(db.queries[0].statement, /foreign_keys = ON/i);
  assert.ok(db.executed.some((sql) => sql.includes("mexc_futures_ohlcv_15m")));
  assert.ok(db.executed.some((sql) => sql.includes("mexc_harsi_results_15m")));
  assert.ok(db.executed.some((sql) => sql.includes("mexc_futures_ohlcv_1h")));
  assert.ok(db.executed.some((sql) => sql.includes("mexc_harsi_results_1h")));
  await store.getHistoricalCandles("BTC_USDT", "2026-11-24T01:00:00.000Z", 2000, "Min60");
  assert.match(db.queries.at(-1).statement, /mexc_futures_ohlcv_1h/);

  const item = {
    current: {
      symbol: "BTC_USDT",
      open_time: "2026-11-24T00:00:00.000Z",
      close_time: "2026-11-24T00:15:00.000Z",
      open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5,
      volume: 3, amount: 4
    },
    currentHarsi: {
      symbol: "BTC_USDT",
      open_time: "2026-11-24T00:00:00.000Z",
      close_time: "2026-11-24T00:15:00.000Z",
      rsi_open: 50, rsi_high: 55, rsi_low: 45, rsi_close: 52,
      ha_open: 50, ha_high: 55, ha_low: 45, ha_close: 52,
      scan_match: null, calculation_version: "test"
    }
  };
  await store.persistCurrentBatch([item]);
  assert.equal(db.sets.length, 1);
  assert.equal(db.sets[0].transaction, true);
  assert.equal(db.sets[0].set.length, 3);
  assert.match(db.sets[0].set[0].statement, /mexc_futures_ohlcv_15m/);
  assert.match(db.sets[0].set[1].statement, /mexc_harsi_results_15m/);
  assert.match(db.sets[0].set[2].statement, /mexc_vwap_values/);
  assert.equal(LOCAL_STORE_LIMITS.historyCandles, 2000);
  assert.equal(LOCAL_STORE_LIMITS.resultRetentionDays, 7);
});

test("local SQLite store uses bounded native batches and parameterized retention", async () => {
  const db = fakeConnection();
  const store = createLocalSqliteStore(db);
  const candles = Array.from({ length: 1200 }, (_, index) => ({
    symbol: "ETH_USDT",
    open_time: new Date(index * 900000).toISOString(),
    close_time: new Date((index + 1) * 900000).toISOString(),
    open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5,
    volume: 3, amount: 4
  }));
  await store.upsertCandles(candles);
  assert.deepEqual(db.sets.map((batch) => batch.set.length), [500, 500, 200]);
  assert.ok(db.sets.every((batch) => batch.transaction === true));

  await store.pruneExpiredHarsi(new Date("2026-11-24T00:00:00.000Z"));
  assert.equal(db.runs.length, 1);
  assert.equal(db.runs[0].values[0], "2026-11-17T00:00:00.000Z");
});


test("concurrent timeframe writes are serialized and initialization runs once", async () => {
  const db = fakeConnection();
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const originalExecuteSet = db.executeSet.bind(db);
  db.executeSet = async (...args) => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await originalExecuteSet(...args);
    } finally {
      activeWrites -= 1;
    }
  };

  const store = createLocalSqliteStore(db);
  await Promise.all([store.initialize(), store.initialize(), store.initialize()]);
  assert.equal(db.executed.length, 14);

  const item = {
    current: {
      symbol: "BTC_USDT",
      open_time: "2026-11-24T00:00:00.000Z",
      close_time: "2026-11-24T00:01:00.000Z",
      open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5,
      volume: 3, amount: 4
    },
    currentHarsi: {
      symbol: "BTC_USDT",
      open_time: "2026-11-24T00:00:00.000Z",
      close_time: "2026-11-24T00:01:00.000Z",
      rsi_open: 50, rsi_high: 55, rsi_low: 45, rsi_close: 52,
      ha_open: 50, ha_high: 55, ha_low: 45, ha_close: 52,
      scan_match: null, calculation_version: "test"
    }
  };
  await Promise.all([
    store.persistCurrentBatch([item], "Min1"),
    store.persistCurrentBatch([item], "Min15"),
    store.persistCurrentBatch([item], "Min1"),
    store.persistCurrentBatch([item], "Min15")
  ]);

  assert.equal(maxActiveWrites, 1);
  assert.equal(db.sets.length, 4);
  assert.ok(db.sets.every((batch) => batch.transaction === true));
});
