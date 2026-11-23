import test from "node:test";
import assert from "node:assert/strict";
import { calculateHarsi } from "../src/harsi.js";

function makeCandles(count, symbol = "TEST_USDT") {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.25 + Math.sin(index / 5);
    const open = 95 + index * 0.18 + Math.cos(index / 7) * 2;
    return {
      symbol,
      open_time: new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString(),
      close_time: new Date(Date.UTC(2026, 0, 1, 0, index * 15 + 15)).toISOString(),
      open_price: open,
      high_price: Math.max(open, close) + 0.5,
      low_price: Math.min(open, close) - 0.5,
      close_price: close,
      volume: 1,
      amount: close
    };
  });
}

function referenceRsi(values, length) {
  let gainTotal = 0;
  let lossTotal = 0;
  for (let index = 1; index <= length; index += 1) {
    const change = values[index] - values[index - 1];
    gainTotal += Math.max(change, 0);
    lossTotal += Math.max(-change, 0);
  }
  let averageGain = gainTotal / length;
  let averageLoss = lossTotal / length;
  for (let index = length + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = ((averageGain * (length - 1)) + Math.max(change, 0)) / length;
    averageLoss = ((averageLoss * (length - 1)) + Math.max(-change, 0)) / length;
  }
  if (averageLoss === 0) return averageGain === 0 ? null : 100;
  if (averageGain === 0) return 0;
  return 100 - (100 / (1 + averageGain / averageLoss));
}

test("HARSI waits for the 200-period RSI warm-up and returns subsequent candles", () => {
  const rows = calculateHarsi(makeCandles(288));
  assert.equal(rows.length, 88);
  assert.equal(rows[0].symbol, "TEST_USDT");
  assert.equal(rows[0].scan_match, null);
  assert.equal(rows[0].calculation_version, "jayrogers-harsi-v2-length-200-smoothing-1-open-rsi");
});

test("RSI open is calculated from the candle open-price series, not prior close RSI", () => {
  const candles = makeCandles(288);
  const rows = calculateHarsi(candles);
  const expectedOpenRsi = referenceRsi(candles.slice(0, 201).map((candle) => candle.open_price), 200) - 50;
  const expectedCloseRsi = referenceRsi(candles.slice(0, 201).map((candle) => candle.close_price), 200) - 50;
  assert.ok(Math.abs(rows[0].rsi_open - expectedOpenRsi) < 1e-10);
  assert.notEqual(rows[0].rsi_open, expectedCloseRsi);
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
