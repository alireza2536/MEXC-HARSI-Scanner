export function mergeCandleHistory(existing, incoming, maxCandles) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new TypeError("Candle history inputs must be arrays.");
  }
  if (!Number.isInteger(maxCandles) || maxCandles < 1) {
    throw new RangeError("maxCandles must be a positive integer.");
  }

  const byOpenTime = new Map();
  for (const candle of [...existing, ...incoming]) {
    byOpenTime.set(candle.open_time, candle);
  }

  return [...byOpenTime.values()]
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
    .slice(-maxCandles);
}

export function hasCompleteCandleWindow(candles, expectedCount, expectedLastOpenTime, intervalMs) {
  if (!Array.isArray(candles) || candles.length !== expectedCount) return false;
  if (!Number.isFinite(expectedLastOpenTime) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return false;
  }

  const openTimes = candles.map((candle) => Date.parse(candle.open_time));
  if (openTimes.some((value) => !Number.isFinite(value))) return false;
  if (openTimes[openTimes.length - 1] !== expectedLastOpenTime) return false;

  for (let index = 1; index < openTimes.length; index += 1) {
    if (openTimes[index] - openTimes[index - 1] !== intervalMs) return false;
  }

  return true;
}
