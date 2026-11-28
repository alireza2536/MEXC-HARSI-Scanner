import test from "node:test";
import assert from "node:assert/strict";
import {
  getMissingCandleRanges,
  hasCompleteCandleWindow,
  mergeCandleHistory
} from "../src/candle-history-cache.js";

function candle(openTime, closePrice) {
  return {
    symbol: "AKE_USDT",
    open_time: new Date(openTime).toISOString(),
    close_price: closePrice
  };
}

test("incremental candle updates replace the same open time and append new candles", () => {
  const first = candle(Date.UTC(2026, 0, 1, 0, 0), 1);
  const second = candle(Date.UTC(2026, 0, 1, 0, 15), 2);
  const revisedSecond = candle(Date.UTC(2026, 0, 1, 0, 15), 2.5);
  const third = candle(Date.UTC(2026, 0, 1, 0, 30), 3);

  const merged = mergeCandleHistory([first, second], [revisedSecond, third], 10);

  assert.equal(merged.length, 3);
  assert.equal(merged[1].close_price, 2.5);
  assert.equal(merged[2].close_price, 3);
});

test("incremental candle history remains chronological and keeps only the newest limit", () => {
  const candles = Array.from({ length: 5 }, (_, index) =>
    candle(Date.UTC(2026, 0, 1, 0, index * 15), index)
  );

  const merged = mergeCandleHistory(candles.slice(0, 3), candles.slice(3), 3);

  assert.deepEqual(
    merged.map((item) => item.close_price),
    [2, 3, 4]
  );
});

test("a cached window is accepted only when it has the exact size and expected latest candle", () => {
  const candles = Array.from({ length: 4 }, (_, index) =>
    candle(Date.UTC(2026, 0, 1, 0, index * 15), index)
  );

  assert.equal(
    hasCompleteCandleWindow(candles, 4, Date.parse(candles[3].open_time), 15 * 60 * 1000),
    true
  );
  assert.equal(
    hasCompleteCandleWindow(candles.slice(1), 4, Date.parse(candles[3].open_time), 15 * 60 * 1000),
    false
  );
  assert.equal(
    hasCompleteCandleWindow(candles, 4, Date.parse(candles[3].open_time) + 15 * 60 * 1000, 15 * 60 * 1000),
    false
  );
});

test("a cached window with a missing interval is rejected", () => {
  const candles = [
    candle(Date.UTC(2026, 0, 1, 0, 0), 1),
    candle(Date.UTC(2026, 0, 1, 0, 15), 2),
    candle(Date.UTC(2026, 0, 1, 0, 45), 4)
  ];

  assert.equal(
    hasCompleteCandleWindow(candles, 3, Date.parse(candles[2].open_time), 15 * 60 * 1000),
    false
  );
});

test("missing candle detection returns only contiguous missing ranges", () => {
  const start = Date.UTC(2026, 0, 1, 0, 0);
  const interval = 15 * 60 * 1000;
  const cached = [0, 1, 4, 5, 8].map((index) => candle(start + index * interval, index));

  assert.deepEqual(
    getMissingCandleRanges(cached, start, 10, interval),
    [
      { startOpenTime: start + 2 * interval, endOpenTime: start + 3 * interval },
      { startOpenTime: start + 6 * interval, endOpenTime: start + 7 * interval },
      { startOpenTime: start + 9 * interval, endOpenTime: start + 9 * interval }
    ]
  );
});

test("missing candle detection requests the full window only when the cache is empty", () => {
  const start = Date.UTC(2026, 0, 1, 0, 0);
  const interval = 15 * 60 * 1000;

  assert.deepEqual(
    getMissingCandleRanges([], start, 3, interval),
    [{ startOpenTime: start, endOpenTime: start + 2 * interval }]
  );
});

test("missing candle detection returns no ranges for a complete window", () => {
  const start = Date.UTC(2026, 0, 1, 0, 0);
  const interval = 15 * 60 * 1000;
  const cached = Array.from({ length: 3 }, (_, index) => candle(start + index * interval, index));

  assert.deepEqual(getMissingCandleRanges(cached, start, 3, interval), []);
});
