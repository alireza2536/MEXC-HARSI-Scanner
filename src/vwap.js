export const DEFAULT_ROLLING_VWAP_CANDLES = 96;

function timestampOf(candle) {
  const value = Date.parse(candle?.open_time);
  return Number.isFinite(value) ? value : NaN;
}

function weightedVwap(candles) {
  let priceVolume = 0;
  let totalVolume = 0;
  for (const candle of candles) {
    const high = Number(candle.high_price);
    const low = Number(candle.low_price);
    const close = Number(candle.close_price);
    const volume = Number(candle.volume);
    if (![high, low, close, volume].every(Number.isFinite) || volume <= 0) continue;
    const typicalPrice = (high + low + close) / 3;
    priceVolume += typicalPrice * volume;
    totalVolume += volume;
  }
  return totalVolume > 0 ? priceVolume / totalVolume : null;
}

/**
 * Calculates UTC-session VWAP and rolling VWAP from OHLCV candles.
 * Uses typical price (H + L + C) / 3 weighted by candle volume.
 * The currently forming candle is included when supplied.
 */
export function calculateVwapPair(
  candles,
  nowMs = Date.now(),
  rollingCandles = DEFAULT_ROLLING_VWAP_CANDLES
) {
  if (!Array.isArray(candles)) throw new TypeError("VWAP candles must be an array.");
  if (!Number.isFinite(nowMs)) throw new TypeError("VWAP calculation time must be a finite timestamp.");
  if (!Number.isInteger(rollingCandles) || rollingCandles < 1) {
    throw new RangeError("Rolling VWAP candle count must be a positive integer.");
  }

  const ordered = candles
    .map((candle) => ({ candle, timestamp: timestampOf(candle) }))
    .filter((item) => Number.isFinite(item.timestamp) && item.timestamp <= nowMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  const utcDayStart = new Date(nowMs);
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const dailyCandles = ordered
    .filter((item) => item.timestamp >= utcDayStart.getTime())
    .map((item) => item.candle);
  const rolling = ordered.slice(-rollingCandles).map((item) => item.candle);

  return {
    vwap_daily: weightedVwap(dailyCandles),
    vwap_rolling: weightedVwap(rolling),
    daily_candle_count: dailyCandles.length,
    rolling_candle_count: rolling.length
  };
}
