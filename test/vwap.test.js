import test from "node:test";
import assert from "node:assert/strict";
import { calculateVwapPair, DEFAULT_ROLLING_VWAP_CANDLES } from "../src/vwap.js";

function candle(openTime, high, low, close, volume) {
  return {
    open_time: new Date(openTime).toISOString(),
    high_price: high,
    low_price: low,
    close_price: close,
    volume
  };
}

test("daily VWAP uses only candles from UTC midnight and includes the current candle", () => {
  const now = Date.parse("2026-11-25T10:30:00.000Z");
  const rows = [
    candle("2026-11-24T23:45:00Z", 12, 10, 11, 100),
    candle("2026-11-25T00:00:00Z", 12, 9, 12, 2),
    candle("2026-11-25T10:15:00Z", 24, 18, 21, 4),
    candle("2026-11-25T10:45:00Z", 100, 90, 95, 1000)
  ];
  const result = calculateVwapPair(rows, now, 2);
  const p1 = (12 + 9 + 12) / 3;
  const p2 = (24 + 18 + 21) / 3;
  assert.equal(result.daily_candle_count, 2);
  assert.equal(result.rolling_candle_count, 2);
  assert.ok(Math.abs(result.vwap_daily - ((p1 * 2 + p2 * 4) / 6)) < 1e-12);
  assert.ok(Math.abs(result.vwap_rolling - ((p1 * 2 + p2 * 4) / 6)) < 1e-12);
});

test("rolling VWAP uses only the latest configured number of candles", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const rows = [
    candle("2026-11-25T09:00:00Z", 3, 3, 3, 100),
    candle("2026-11-25T10:00:00Z", 12, 12, 12, 1),
    candle("2026-11-25T11:00:00Z", 24, 24, 24, 3)
  ];
  const result = calculateVwapPair(rows, now, 2);
  assert.equal(result.rolling_candle_count, 2);
  assert.equal(result.vwap_rolling, 21);
  assert.equal(DEFAULT_ROLLING_VWAP_CANDLES, 96);
});

test("VWAP returns null when all candle volumes are zero or invalid", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const result = calculateVwapPair([candle("2026-11-25T11:00:00Z", 3, 2, 2, 0)], now);
  assert.equal(result.vwap_daily, null);
  assert.equal(result.vwap_rolling, null);
});

test("rolling candle count must be a positive integer", () => {
  assert.throws(() => calculateVwapPair([], Date.now(), 0), RangeError);
});
