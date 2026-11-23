import test from "node:test";
import assert from "node:assert/strict";

const intervalSeconds = 900;

function closedCandleWindow(serverNowSeconds, historyDays = 3) {
  const currentOpen = Math.floor(serverNowSeconds / intervalSeconds) * intervalSeconds;
  const latestClosedOpen = currentOpen - intervalSeconds;
  const start = latestClosedOpen - historyDays * 86400 + intervalSeconds;
  return { start, end: latestClosedOpen, latestClosedOpen };
}

test("selects only the last fully closed 15m candle", () => {
  const now = 1_800_000_123;
  const window = closedCandleWindow(now);
  assert.equal(window.end + intervalSeconds, Math.floor(now / intervalSeconds) * intervalSeconds);
  assert.equal(window.end < now, true);
});

test("three-day history window spans 288 candle openings", () => {
  const window = closedCandleWindow(1_800_000_123);
  assert.equal((window.end - window.start) / intervalSeconds + 1, 288);
});

test("history window is aligned to 15-minute boundaries", () => {
  const window = closedCandleWindow(1_800_000_123);
  assert.equal(window.start % intervalSeconds, 0);
  assert.equal(window.end % intervalSeconds, 0);
});
