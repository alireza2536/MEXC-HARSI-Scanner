import test from "node:test";
import assert from "node:assert/strict";
import { calculateClosedCandleWindow, FIFTEEN_MINUTES_SECONDS } from "../src/candle-window.js";

test("returns exactly 288 closed 15-minute candle opens for three days", () => {
  const serverNowMs = Date.UTC(2026, 10, 23, 10, 7, 0);
  const result = calculateClosedCandleWindow(serverNowMs, 3);
  assert.equal(result.endSeconds, Math.floor(serverNowMs / 1000 / FIFTEEN_MINUTES_SECONDS) * FIFTEEN_MINUTES_SECONDS - FIFTEEN_MINUTES_SECONDS);
  assert.equal(result.endSeconds - result.startSeconds, 287 * FIFTEEN_MINUTES_SECONDS);
});

test("rejects any history duration other than the fixed three days", () => {
  assert.throws(() => calculateClosedCandleWindow(Date.UTC(2026, 10, 23), 2), /exactly three days/);
});

test("rejects an invalid server timestamp", () => {
  assert.throws(() => calculateClosedCandleWindow(0, 3), /positive timestamp/);
});
