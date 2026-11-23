import test from "node:test";
import assert from "node:assert/strict";

const INTERVAL = 900;

function liveWindow(serverNowMs, historyCandles = 200) {
  const nowSeconds = Math.floor(serverNowMs / 1000);
  const currentOpen = Math.floor(nowSeconds / INTERVAL) * INTERVAL;
  return {
    startSeconds: currentOpen - historyCandles * INTERVAL,
    endSeconds: nowSeconds,
    currentOpen
  };
}

test("requests exactly 200 prior intervals and the current forming candle", () => {
  const now = Date.parse("2026-11-23T12:07:30.000Z");
  const result = liveWindow(now);
  assert.equal(result.currentOpen, Date.parse("2026-11-23T12:00:00.000Z") / 1000);
  assert.equal(result.currentOpen - result.startSeconds, 200 * INTERVAL);
  assert.equal(result.endSeconds, Math.floor(now / 1000));
});
