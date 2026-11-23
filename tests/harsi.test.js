import test from "node:test";
import assert from "node:assert/strict";
import { calculateHarsi, wilderRsi, HARSI_CALCULATION_VERSION } from "../src/harsi.js";

test("Wilder RSI seeds with an SMA and then applies Wilder smoothing", () => {
  const values = [10, 11, 10, 11, 10];
  const rsi = wilderRsi(values, 2);
  assert.equal(rsi[0], null);
  assert.equal(rsi[1], null);
  assert.equal(rsi[2], 50);
  assert.equal(rsi[3], 75);
  assert.equal(rsi[4], 37.5);
});

test("HARSI is unavailable until 200 RSI changes exist", () => {
  const candles = Array.from({ length: 200 }, (_, i) => ({
    symbol: "TEST_USDT",
    open_time: new Date(i * 900000).toISOString(),
    close_time: new Date((i + 1) * 900000).toISOString(),
    high_price: 101 + i,
    low_price: 99 + i,
    close_price: 100 + i
  }));
  const results = calculateHarsi(candles);
  assert.equal(results.length, 200);
  assert.equal(results.at(-1).ha_close, null);
});

test("HARSI matches the Pine candle structure on a monotonic series", () => {
  const candles = Array.from({ length: 205 }, (_, i) => ({
    symbol: "TEST_USDT",
    open_time: new Date(i * 900000).toISOString(),
    close_time: new Date((i + 1) * 900000).toISOString(),
    high_price: 102 + i,
    low_price: 98 + i,
    close_price: 100 + i
  }));
  const results = calculateHarsi(candles);
  const firstValid = results[200];
  assert.equal(firstValid.rsi_close, 50);
  assert.equal(firstValid.rsi_high, 50);
  assert.equal(firstValid.rsi_low, 50);
  assert.equal(firstValid.ha_close, 50);
  assert.equal(firstValid.ha_open, 50);
  assert.equal(firstValid.scan_match, true);
  assert.equal(firstValid.calculation_version, HARSI_CALCULATION_VERSION);
  assert.equal(results[204].ha_close, 50);
});

test("HA_Close threshold is strictly greater than 5.5", () => {
  const candles = Array.from({ length: 205 }, (_, i) => ({
    symbol: "TEST_USDT",
    open_time: new Date(i * 900000).toISOString(),
    close_time: new Date((i + 1) * 900000).toISOString(),
    high_price: 102 + i,
    low_price: 98 + i,
    close_price: 100 + i
  }));
  const result = calculateHarsi(candles, { threshold: 50 })[200];
  assert.equal(result.ha_close, 50);
  assert.equal(result.scan_match, false);
});
