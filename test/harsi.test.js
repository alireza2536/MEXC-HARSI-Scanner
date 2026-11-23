import test from "node:test";
import assert from "node:assert/strict";
import { calculateHarsi } from "../src/harsi.js";

function makeCandles(count, symbol = "TEST_USDT") {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.25 + Math.sin(index / 5);
    return {
      symbol,
      open_time: new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString(),
      close_time: new Date(Date.UTC(2026, 0, 1, 0, index * 15 + 15)).toISOString(),
      open_price: close - 0.1,
      high_price: close + 0.5,
      low_price: close - 0.5,
      close_price: close,
      volume: 1,
      amount: close
    };
  });
}

test("HARSI waits for the 200-period RSI warm-up and returns subsequent candles", () => {
  const rows = calculateHarsi(makeCandles(288));
  assert.equal(rows.length, 88);
  assert.equal(rows[0].symbol, "TEST_USDT");
  assert.equal(rows[0].scan_match, null);
  assert.equal(rows[0].calculation_version, "jayrogers-harsi-v1-length-200-smoothing-1");
});

test("HARSI outputs finite RSI and Heikin Ashi values after warm-up", () => {
  const rows = calculateHarsi(makeCandles(288));
  for (const row of rows) {
    for (const field of [
      "rsi_open", "rsi_high", "rsi_low", "rsi_close",
      "ha_open", "ha_high", "ha_low", "ha_close"
    ]) {
      assert.ok(Number.isFinite(row[field]), `${field} should be finite`);
    }
    assert.ok(row.ha_high >= Math.max(row.ha_open, row.ha_close));
    assert.ok(row.ha_low <= Math.min(row.ha_open, row.ha_close));
  }
});

test("HARSI calculation does not apply a signal or price-selection condition", () => {
  const rows = calculateHarsi(makeCandles(288));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.scan_match === null));
});

test("HARSI sorts candles chronologically before calculating", () => {
  const candles = makeCandles(288);
  const ordered = calculateHarsi(candles);
  const reversed = calculateHarsi([...candles].reverse());
  assert.deepEqual(reversed, ordered);
});

test("HARSI returns no rows when there is insufficient RSI history", () => {
  assert.deepEqual(calculateHarsi(makeCandles(200)), []);
});
