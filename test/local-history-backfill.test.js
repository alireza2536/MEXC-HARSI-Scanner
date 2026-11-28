import test from "node:test";
import assert from "node:assert/strict";
import { getLocalHistoricalCandles } from "../src/local-scanner.js";

const INTERVALS = { Min5: 300, Min15: 900, Min60: 3600 };

function makeCandles(symbol, startSeconds, count, intervalSeconds) {
  return Array.from({ length: count }, (_, index) => {
    const open = startSeconds + index * intervalSeconds;
    return {
      symbol,
      open_time: new Date(open * 1000).toISOString(),
      close_time: new Date((open + intervalSeconds) * 1000).toISOString(),
      open_price: 100 + index,
      high_price: 102 + index,
      low_price: 99 + index,
      close_price: 101 + index,
      volume: 10,
      amount: 1000
    };
  });
}

function createStore(initialCandles) {
  const state = [...initialCandles];
  const writes = [];
  return {
    state,
    writes,
    async getHistoricalCandles() {
      return [...state].sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
    },
    async upsertCandles(rows, timeframe) {
      writes.push({ rows, timeframe });
      const byTime = new Map(state.map((row) => [row.open_time, row]));
      for (const row of rows) byTime.set(row.open_time, row);
      state.splice(0, state.length, ...[...byTime.values()].sort(
        (a, b) => Date.parse(a.open_time) - Date.parse(b.open_time)
      ));
    }
  };
}

for (const [timeframe, intervalSeconds] of Object.entries(INTERVALS)) {
  test(`${timeframe} Android history backfills only missing candles`, async () => {
    const symbol = "TEST_USDT";
    const startSeconds = 1_800_000_000;
    const currentOpen = startSeconds + 2000 * intervalSeconds;
    const complete = makeCandles(symbol, startSeconds, 2000, intervalSeconds);
    const cached = complete.filter((_, index) => index !== 100 && index !== 1500);
    const store = createStore(cached);
    const requests = [];
    const mexc = {
      async getCandles(requestSymbol, requestTimeframe, start, end) {
        requests.push({ requestSymbol, requestTimeframe, start, end });
        return complete.filter((row) => {
          const open = Date.parse(row.open_time) / 1000;
          return open >= start && open <= end;
        });
      }
    };

    const result = await getLocalHistoricalCandles(
      store, mexc, symbol, currentOpen, undefined, timeframe, intervalSeconds
    );

    assert.equal(result.cacheHit, false);
    assert.equal(result.candles.length, 2000);
    assert.equal(store.state.length, 2000);
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0].timeframe, timeframe);
    assert.equal(store.writes[0].rows.length, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ start, end }) => [start, end]), [
      [startSeconds + 100 * intervalSeconds, startSeconds + 100 * intervalSeconds],
      [startSeconds + 1500 * intervalSeconds, startSeconds + 1500 * intervalSeconds]
    ]);
  });

  test(`${timeframe} Android history cache hit makes no MEXC history request`, async () => {
    const symbol = "TEST_USDT";
    const startSeconds = 1_800_000_000;
    const currentOpen = startSeconds + 2000 * intervalSeconds;
    const complete = makeCandles(symbol, startSeconds, 2000, intervalSeconds);
    const store = createStore(complete);
    let requests = 0;
    const mexc = {
      async getCandles() {
        requests += 1;
        return [];
      }
    };

    const result = await getLocalHistoricalCandles(
      store, mexc, symbol, currentOpen, undefined, timeframe, intervalSeconds
    );

    assert.equal(result.cacheHit, true);
    assert.equal(result.candles.length, 2000);
    assert.equal(requests, 0);
    assert.equal(store.writes.length, 0);
  });
}

test("Android history requests the full window only when SQLite is empty", async () => {
  const symbol = "EMPTY_USDT";
  const intervalSeconds = 900;
  const startSeconds = 1_800_000_000;
  const currentOpen = startSeconds + 2000 * intervalSeconds;
  const complete = makeCandles(symbol, startSeconds, 2000, intervalSeconds);
  const store = createStore([]);
  const requests = [];
  const mexc = {
    async getCandles(requestSymbol, timeframe, start, end) {
      requests.push({ requestSymbol, timeframe, start, end });
      return complete;
    }
  };

  const result = await getLocalHistoricalCandles(
    store, mexc, symbol, currentOpen, undefined, "Min15", intervalSeconds
  );

  assert.equal(result.candles.length, 2000);
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].start, requests[0].end], [
    startSeconds,
    currentOpen - 1
  ]);
  assert.equal(store.writes[0].rows.length, 2000);
});

test("Android history fails rather than accepting an incomplete backfill", async () => {
  const intervalSeconds = 300;
  const startSeconds = 1_800_000_000;
  const currentOpen = startSeconds + 2000 * intervalSeconds;
  const complete = makeCandles("GAP_USDT", startSeconds, 2000, intervalSeconds);
  const store = createStore([]);
  const mexc = {
    async getCandles() {
      return complete.slice(0, -1);
    }
  };

  await assert.rejects(
    getLocalHistoricalCandles(
      store, mexc, "GAP_USDT", currentOpen, undefined, "Min5", intervalSeconds
    ),
    { code: "INCOMPLETE_CANDLE_HISTORY" }
  );
  assert.equal(store.writes.length, 0);
});
