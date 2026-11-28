export const HARSI_LENGTH = 200;
const OPEN_SMOOTHING = 1;
const CALCULATION_VERSION = "jayrogers-pine-v4-length-200-smoothing-1";

function rsiValues(values, length) {
  const result = Array(values.length).fill(null);
  let previousAverageGain = null;
  let previousAverageLoss = null;

  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    if (index < length) continue;

    if (index === length) {
      let gainTotal = 0;
      let lossTotal = 0;
      for (let offset = index - length + 1; offset <= index; offset += 1) {
        const delta = values[offset] - values[offset - 1];
        gainTotal += Math.max(delta, 0);
        lossTotal += Math.max(-delta, 0);
      }
      previousAverageGain = gainTotal / length;
      previousAverageLoss = lossTotal / length;
    } else {
      previousAverageGain = ((previousAverageGain * (length - 1)) + gain) / length;
      previousAverageLoss = ((previousAverageLoss * (length - 1)) + loss) / length;
    }

    if (previousAverageGain === 0 && previousAverageLoss === 0) {
      result[index] = null;
    } else if (previousAverageLoss === 0) {
      result[index] = 100;
    } else if (previousAverageGain === 0) {
      result[index] = 0;
    } else {
      const relativeStrength = previousAverageGain / previousAverageLoss;
      result[index] = 100 - (100 / (1 + relativeStrength));
    }
  }

  return result;
}

function toFiniteNumber(value, field, symbol) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid ${field} for ${symbol}`);
  }
  return number;
}

/**
 * Reproduces JayRogers' Pine v4 f_rsiHeikinAshi() for the fixed scanner
 * settings: HARSI RSI length 200 and Open Smoothing 1.
 * Inputs must be chronological, closed OHLCV candles.
 */
export function calculateHarsi(candles) {
  if (!Array.isArray(candles)) throw new TypeError("Candles must be an array.");

  const ordered = [...candles].sort(
    (left, right) => Date.parse(left.open_time) - Date.parse(right.open_time)
  );
  if (ordered.length === 0) return [];

  const highs = ordered.map((candle) => toFiniteNumber(candle.high_price, "high_price", candle.symbol));
  const lows = ordered.map((candle) => toFiniteNumber(candle.low_price, "low_price", candle.symbol));
  const closes = ordered.map((candle) => toFiniteNumber(candle.close_price, "close_price", candle.symbol));

  // JayRogers Pine v4 derives HARSI open RSI from the previous close RSI.
  const closeRsiValues = rsiValues(closes, HARSI_LENGTH).map((value) => value === null ? null : value - 50);
  const highRsiValues = rsiValues(highs, HARSI_LENGTH).map((value) => value === null ? null : value - 50);
  const lowRsiValues = rsiValues(lows, HARSI_LENGTH).map((value) => value === null ? null : value - 50);

  const output = [];
  const haOpen = Array(ordered.length).fill(null);
  const haClose = Array(ordered.length).fill(null);

  for (let index = 0; index < ordered.length; index += 1) {
    if (
      highRsiValues[index] === null ||
      lowRsiValues[index] === null ||
      closeRsiValues[index] === null
    ) continue;

    // Pine: nz(_closeRSI[1], _closeRSI) — use current close RSI on the first valid bar.
    const openRsi = index > 0 && closeRsiValues[index - 1] !== null
      ? closeRsiValues[index - 1]
      : closeRsiValues[index];
    const highRsiValue = Math.max(highRsiValues[index], lowRsiValues[index]);
    const lowRsiValue = Math.min(highRsiValues[index], lowRsiValues[index]);
    const closeRsi = closeRsiValues[index];
    const closeValue = (openRsi + highRsiValue + lowRsiValue + closeRsi) / 4;

    const priorOpenAtSmoothingOffset = index - OPEN_SMOOTHING >= 0
      ? haOpen[index - OPEN_SMOOTHING]
      : null;

    let openValue;
    if (priorOpenAtSmoothingOffset === null) {
      openValue = (openRsi + closeRsi) / 2;
    } else {
      openValue = (
        (haOpen[index - 1] * OPEN_SMOOTHING) + haClose[index - 1]
      ) / (OPEN_SMOOTHING + 1);
    }

    const highValue = Math.max(highRsiValue, openValue, closeValue);
    const lowValue = Math.min(lowRsiValue, openValue, closeValue);

    haOpen[index] = openValue;
    haClose[index] = closeValue;

    output.push({
      symbol: ordered[index].symbol,
      open_time: ordered[index].open_time,
      close_time: ordered[index].close_time,
      rsi_open: openRsi,
      rsi_high: highRsiValue,
      rsi_low: lowRsiValue,
      rsi_close: closeRsi,
      ha_open: openValue,
      ha_high: highValue,
      ha_low: lowValue,
      ha_close: closeValue,
      scan_match: null,
      calculation_version: CALCULATION_VERSION
    });
  }

  return output;
}
