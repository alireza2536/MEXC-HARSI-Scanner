import test from "node:test";
import assert from "node:assert/strict";
import { mergeCandleHistory } from "../src/candle-history-cache.js";

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
