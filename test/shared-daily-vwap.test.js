import test from "node:test";
import assert from "node:assert/strict";
import { getSharedDailyVwap } from "../src/local-scanner.js";

function candle(time, high, low, close, volume) {
  return { open_time: new Date(time).toISOString(), high_price: high, low_price: low, close_price: close, volume };
}

test("5m and 1h use the same cached 15m daily VWAP", async () => {
  const now = Date.parse("2026-11-26T12:30:00.000Z");
  const dayStart = Math.floor(Date.parse("2026-11-26T00:00:00.000Z") / 1000);
  const rows = [
    candle("2026-11-26T00:00:00Z", 10, 8, 9, 2),
    candle("2026-11-26T12:15:00Z", 20, 16, 18, 4)
  ];
  let calls = 0;
  const mexc = { async getCandles(symbol, timeframe, start, end) {
    calls++;
    assert.equal(symbol, "BTC_USDT");
    assert.equal(timeframe, "Min15");
    assert.equal(start, dayStart);
    assert.equal(end, Math.floor(now / 1000));
    return rows;
  }};
  const cache = new Map();
  const [five, hour] = await Promise.all([
    getSharedDailyVwap({ mexc, symbol: "BTC_USDT", timeframe: "Min5", candles: [], serverNowMs: now, nowSeconds: Math.floor(now / 1000), cache }),
    getSharedDailyVwap({ mexc, symbol: "BTC_USDT", timeframe: "Min60", candles: [], serverNowMs: now, nowSeconds: Math.floor(now / 1000), cache })
  ]);
  assert.deepEqual(five, hour);
  assert.equal(calls, 1);
  assert.equal(five.daily_candle_count, 2);
});

test("15m scan calculates canonical VWAP from its own 15m candle window", async () => {
  const now = Date.parse("2026-11-26T12:30:00.000Z");
  const rows = [candle("2026-11-26T12:15:00Z", 20, 16, 18, 4)];
  let calls = 0;
  const value = await getSharedDailyVwap({
    mexc: { async getCandles() { calls++; throw new Error("should not fetch again"); } },
    symbol: "BTC_USDT", timeframe: "Min15", candles: rows,
    serverNowMs: now, nowSeconds: Math.floor(now / 1000), cache: new Map()
  });
  assert.equal(calls, 0);
  assert.equal(value.daily_candle_count, 1);
  assert.ok(Math.abs(value.vwap_daily - 18) < 1e-12);
});
