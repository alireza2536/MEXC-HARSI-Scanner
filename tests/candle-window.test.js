import test from "node:test";
import assert from "node:assert/strict";
import { calculateClosedCandleWindow, FIFTEEN_MINUTES_SECONDS } from "../src/candle-window.js";

test("selects only the last fully closed 15m candle", () => {
  const nowMs = 1_800_000_123_000;
  const window = calculateClosedCandleWindow(nowMs);
  const currentCandleOpen = Math.floor(Math.floor(nowMs / 1000) / FIFTEEN_MINUTES_SECONDS) * FIFTEEN_MINUTES_SECONDS;
  assert.equal(window.endSeconds, currentCandleOpen - FIFTEEN_MINUTES_SECONDS);
  assert.equal(window.endSeconds < nowMs / 1000, true);
});

test("three-day history window contains exactly 288 candle openings", () => {
  const window = calculateClosedCandleWindow(1_800_000_123_000);
  assert.equal((window.endSeconds - window.startSeconds) / FIFTEEN_MINUTES_SECONDS + 1, 288);
});

test("window boundaries align to 15-minute intervals", () => {
  const window = calculateClosedCandleWindow(1_800_000_123_000);
  assert.equal(window.startSeconds % FIFTEEN_MINUTES_SECONDS, 0);
  assert.equal(window.endSeconds % FIFTEEN_MINUTES_SECONDS, 0);
});

test("rejects unsupported retention windows", () => {
  assert.throws(() => calculateClosedCandleWindow(Date.now(), 7), /exactly three days/);
});
