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
