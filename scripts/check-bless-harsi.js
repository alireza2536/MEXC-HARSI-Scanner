import { calculateHarsi } from "../src/harsi.js";

const BASE = "https://contract.mexc.com";
const SYMBOL = "BLESS_USDT";
const INTERVAL_SECONDS = 900;
const LENGTH = 200;
const SMOOTHING = 1;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const body = await response.json();
  if (body?.success === false || (body?.code !== undefined && Number(body.code) !== 0)) {
    throw new Error(`MEXC API error: ${body.message || body.code}`);
  }
  return body.data;
}

const serverTime = Number(await getJson(`${BASE}/api/v1/contract/ping`));
if (!Number.isFinite(serverTime) || serverTime <= 0) throw new Error("Invalid MEXC server time");
const latestClosedOpen = Math.floor(serverTime / 1000 / INTERVAL_SECONDS) * INTERVAL_SECONDS - INTERVAL_SECONDS;
const start = latestClosedOpen - (1999 * INTERVAL_SECONDS);
const end = latestClosedOpen + INTERVAL_SECONDS;

const data = await getJson(`${BASE}/api/v1/contract/kline/${SYMBOL}?interval=Min15&start=${start}&end=${end}`);
if (!data || !Array.isArray(data.time)) throw new Error("Invalid MEXC kline response");
for (const key of ["open", "high", "low", "close", "vol", "amount"]) {
  if (!Array.isArray(data[key]) || data[key].length !== data.time.length) {
    throw new Error(`Malformed ${key} array in MEXC response`);
  }
}

const candles = data.time.map((t, i) => ({
  symbol: SYMBOL,
  open_time: new Date(Number(t) * 1000).toISOString(),
  close_time: new Date((Number(t) + INTERVAL_SECONDS) * 1000).toISOString(),
  open_price: Number(data.open[i]),
  high_price: Number(data.high[i]),
  low_price: Number(data.low[i]),
  close_price: Number(data.close[i]),
  volume: Number(data.vol[i]),
  amount: Number(data.amount[i])
})).filter(c => Date.parse(c.close_time) <= serverTime)
  .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));

if (candles.length < LENGTH + 2) {
  throw new Error(`Insufficient closed candles: ${candles.length}; need at least ${LENGTH + 2}`);
}
const result = calculateHarsi(candles, {
  length: LENGTH,
  openSmoothing: SMOOTHING,
  threshold: 5.5
});
const latest = result.at(-1);
if (!latest || latest.ha_close === null) throw new Error("Latest closed candle has no HA_Close");

console.log("HARSI_SINGLE_SYMBOL_RESULT");
console.log(JSON.stringify({
  symbol: SYMBOL,
  timeframe: "15m",
  source: "MEXC contract kline",
  server_time_utc: new Date(serverTime).toISOString(),
  latest_closed_candle_open_utc: latest.open_time,
  latest_closed_candle_close_utc: latest.close_time,
  closed_candles_used: candles.length,
  harsi_length: LENGTH,
  open_smoothing: SMOOTHING,
  ha_close: Number(latest.ha_close.toFixed(10)),
  condition_ha_close_gt_5_5: latest.scan_match
}, null, 2));
