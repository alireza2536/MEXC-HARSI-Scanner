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

export function getMissingCandleRanges(candles, expectedStartOpenTime, expectedCount, intervalMs) {
  if (!Array.isArray(candles)) {
    throw new TypeError("candles must be an array.");
  }
  if (!Number.isFinite(expectedStartOpenTime)) {
    throw new TypeError("expectedStartOpenTime must be a valid timestamp.");
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new RangeError("expectedCount must be a positive integer.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive number.");
  }

  const existingOpenTimes = new Set(
    candles
      .map((candle) => Date.parse(candle.open_time))
      .filter(Number.isFinite)
  );
  const ranges = [];
  let rangeStart = null;
  let rangeEnd = null;

  const finishRange = () => {
    if (rangeStart !== null) {
      ranges.push({ startOpenTime: rangeStart, endOpenTime: rangeEnd });
      rangeStart = null;
      rangeEnd = null;
    }
  };

  for (let index = 0; index < expectedCount; index += 1) {
    const expectedOpenTime = expectedStartOpenTime + index * intervalMs;
    if (existingOpenTimes.has(expectedOpenTime)) {
      finishRange();
      continue;
    }

    if (rangeStart === null) rangeStart = expectedOpenTime;
    rangeEnd = expectedOpenTime;
  }

  finishRange();
  return ranges;
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
