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
  assert.equal(db.executed.length, 16);
  assert.match(db.queries[0].statement, /foreign_keys = ON/i);
  assert.ok(db.executed.some((sql) => sql.includes("mexc_futures_ohlcv_5m")));
  assert.ok(db.executed.some((sql) => sql.includes("mexc_harsi_results_5m")));
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
  assert.doesNotMatch(db.sets[0].set[2].statement, /vwap_rolling|rolling_candle_count/);
  assert.equal(LOCAL_STORE_LIMITS.historyCandles, 2000);
  assert.equal(LOCAL_STORE_LIMITS.resultRetentionDays, 7);
});

test("rolling 4h rows are removed for an invalid 8-candle window and rebuilt from the latest window", async () => {
  const db = fakeConnection();
  let latestWindow = [];
  const originalQuery = db.query.bind(db);
  db.query = async (statement, values) => {
    if (statement.includes("FROM mexc_futures_ohlcv_1h")) {
      return { values: [...latestWindow].reverse() };
    }
    return originalQuery(statement, values);
  };
  const store = createLocalSqliteStore(db);
  const makeHourly = (start, count = 8) => Array.from({ length: count }, (_, index) => ({
    symbol: "BTC_USDT",
    open_time: new Date(start + index * 3600000).toISOString(),
    close_time: new Date(start + (index + 1) * 3600000).toISOString(),
    open_price: 100 + index, high_price: 105 + index, low_price: 95 + index,
    close_price: 102 + index, volume: 10, amount: 1000
  }));
  const firstStart = Date.parse("2026-11-24T00:00:00.000Z");
  latestWindow = makeHourly(firstStart);
  latestWindow[4] = { ...latestWindow[4], open_time: new Date(firstStart + 5 * 3600000).toISOString() };
  const item = {
    current: { ...makeHourly(firstStart)[7] },
    currentHarsi: {
      symbol: "BTC_USDT", open_time: new Date(firstStart + 7 * 3600000).toISOString(),
      close_time: new Date(firstStart + 8 * 3600000).toISOString(),
      rsi_open: 50, rsi_high: 55, rsi_low: 45, rsi_close: 52,
      ha_open: 50, ha_high: 55, ha_low: 45, ha_close: 52,
      scan_match: null, calculation_version: "test"
    },
    currentVwap: { vwap_daily: 103, daily_candle_count: 8 }
  };

  const invalidRows = await store.persistCurrentBatch([item], "Min60");
  assert.deepEqual(invalidRows, []);
  const invalidationSet = db.sets.at(-1).set;
  assert.equal(invalidationSet.length, 1);
  assert.match(invalidationSet[0].statement, /DELETE FROM mexc_futures_ohlcv_4h/);

  // Simulate a two-day pause: the database query now returns the newest eight
  // hourly candles, and the rolling 4h pair is rebuilt from this later window.
  const laterStart = Date.parse("2026-11-26T00:00:00.000Z");
  latestWindow = makeHourly(laterStart);
  item.current = { ...latestWindow[7] };
  item.currentHarsi.open_time = latestWindow[7].open_time;
  item.currentHarsi.close_time = latestWindow[7].close_time;
  const rebuiltRows = await store.persistCurrentBatch([item], "Min60");
  assert.equal(rebuiltRows.length, 2);
  assert.equal(rebuiltRows[0].open_time, latestWindow[0].open_time);
  assert.equal(rebuiltRows[1].open_time, latestWindow[4].open_time);
  assert.ok(Date.parse(rebuiltRows[1].open_time) > firstStart + 86400000);
});

test("rolling 4h invalidation deletes only the selected symbol in a transaction", async () => {
  const db = fakeConnection();
  const store = createLocalSqliteStore(db);
  await store.invalidateRollingFourHour("BTC_USDT");
  const operation = db.sets.at(-1);
  assert.equal(operation.transaction, true);
  assert.equal(operation.set.length, 1);
  assert.deepEqual(operation.set[0].values, ["BTC_USDT"]);
  assert.match(operation.set[0].statement, /DELETE FROM mexc_futures_ohlcv_4h/);
});

test("latest HA query qualifies sort columns after joining VWAP", async () => {
  const db = fakeConnection();
  const store = createLocalSqliteStore(db);
  await store.getLatestHarsiResults(1000, "Min5");
  const sql = db.queries.at(-1).statement;
  assert.match(sql, /mexc_harsi_results_5m/);
  assert.match(sql, /LEFT JOIN mexc_futures_ohlcv_5m current_candle/);
  assert.match(sql, /current_candle\.close_price/);
  assert.match(sql, /AS previous_close_price/);
  assert.match(sql, /previous_candle\.open_time < latest\.open_time/);
  assert.match(sql, /ORDER BY latest\.close_time DESC, latest\.symbol ASC LIMIT \?/);
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
  assert.equal(db.executed.length, 16);

  const item = {
    current: {
      symbol: "BTC_USDT",
      open_time: "2026-11-24T00:00:00.000Z",
      close_time: "2026-11-24T00:05:00.000Z",
      open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5,
      volume: 3, amount: 4
    },
    currentHarsi: {
      symbol: "BTC_USDT",
      open_time: "2026-11-24T00:00:00.000Z",
      close_time: "2026-11-24T00:05:00.000Z",
      rsi_open: 50, rsi_high: 55, rsi_low: 45, rsi_close: 52,
      ha_open: 50, ha_high: 55, ha_low: 45, ha_close: 52,
      scan_match: null, calculation_version: "test"
    }
  };
  await Promise.all([
    store.persistCurrentBatch([item], "Min5"),
    store.persistCurrentBatch([item], "Min15"),
    store.persistCurrentBatch([item], "Min5"),
    store.persistCurrentBatch([item], "Min15")
  ]);

  assert.equal(maxActiveWrites, 1);
  assert.equal(db.sets.length, 4);
  assert.ok(db.sets.every((batch) => batch.transaction === true));
});


test("local SQLite store persists exactly two rolling 4-hour rows after hourly updates", async () => {
  const db = fakeConnection();
  const start = Date.parse("2026-11-26T00:00:00.000Z");
  const hourly = Array.from({ length: 8 }, (_, index) => ({
    symbol: "BTC_USDT",
    open_time: new Date(start + index * 3600000).toISOString(),
    close_time: new Date(start + (index + 1) * 3600000).toISOString(),
    open_price: 100 + index, high_price: 105 + index, low_price: 95 + index,
    close_price: 102 + index, volume: 10, amount: 1000
  }));
  const originalQuery = db.query.bind(db);
  db.query = async (statement, values) => {
    if (statement.includes("FROM mexc_futures_ohlcv_1h")) return { values: [...hourly].reverse() };
    return originalQuery(statement, values);
  };
  const store = createLocalSqliteStore(db);
  const item = {
    current: { ...hourly[7] },
    currentHarsi: {
      symbol: "BTC_USDT", open_time: hourly[7].open_time, close_time: hourly[7].close_time,
      rsi_open: 50, rsi_high: 55, rsi_low: 45, rsi_close: 52,
      ha_open: 50, ha_high: 55, ha_low: 45, ha_close: 52,
      scan_match: null, calculation_version: "test"
    },
    currentVwap: { vwap_daily: 103.5, daily_candle_count: 20 }
  };
  const rows = await store.persistCurrentBatch([item], "Min60");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].open_time, hourly[0].open_time);
  assert.equal(rows[1].open_time, hourly[4].open_time);
  assert.equal(rows[0].vwap_daily, 103.5);
  assert.equal(db.sets.length, 2);
  assert.equal(db.sets[1].transaction, true);
  assert.equal(db.sets[1].set.length, 3);
  assert.match(db.sets[1].set[0].statement, /DELETE FROM mexc_futures_ohlcv_4h/);
  assert.equal(db.sets[1].set.filter((operation) => /INSERT INTO mexc_futures_ohlcv_4h/.test(operation.statement)).length, 2);

  await store.getLatestVwap4hResults();
  assert.match(db.queries.at(-1).statement, /ROW_NUMBER\(\) OVER/);
  assert.match(db.queries.at(-1).statement, /previous\.position = 2/);
});
