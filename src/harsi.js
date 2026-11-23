// Port of JayRogers' Pine Script v4 "Heikin Ashi RSI Oscillator".
// This implements only the HARSI candle path (f_rsiHeikinAshi), not the
// separate RSI plot or Stochastic RSI. Pine's rsi() uses Wilder/RMA smoothing.

export const HARSI_CALCULATION_VERSION = "jayrogers-pine-v4-harsi-1.0.0";

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function wilderRsi(values, length = 200) {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error("RSI length must be a positive integer.");
  }
  const output = Array(values.length).fill(null);
  if (values.length <= length) return output;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= length; i += 1) {
    const change = values[i] - values[i - 1];
    if (!Number.isFinite(change)) throw new Error(`Invalid RSI source value at index ${i}`);
    gainSum += Math.max(change, 0);
    lossSum += Math.max(-change, 0);
  }

  let averageGain = gainSum / length;
  let averageLoss = lossSum / length;

  const toRsi = (gain, loss) => {
    if (gain === 0 && loss === 0) return null;
    if (loss === 0) return 100;
    if (gain === 0) return 0;
    return 100 - (100 / (1 + gain / loss));
  };

  output[length] = finiteOrNull(toRsi(averageGain, averageLoss));

  for (let i = length + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (!Number.isFinite(change)) throw new Error(`Invalid RSI source value at index ${i}`);
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = ((averageGain * (length - 1)) + gain) / length;
    averageLoss = ((averageLoss * (length - 1)) + loss) / length;
    output[i] = finiteOrNull(toRsi(averageGain, averageLoss));
  }

  return output;
}

const maxDefined = (...values) => values.every(Number.isFinite) ? Math.max(...values) : null;
const minDefined = (...values) => values.every(Number.isFinite) ? Math.min(...values) : null;

export function calculateHarsi(candles, {
  length = 200,
  openSmoothing = 1,
  threshold = 5.5
} = {}) {
  if (!Array.isArray(candles)) throw new Error("candles must be an array.");
  if (!Number.isInteger(openSmoothing) || openSmoothing < 1 || openSmoothing > 100) {
    throw new Error("Open smoothing must be an integer from 1 to 100.");
  }

  const sorted = [...candles].sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
  const closes = sorted.map((c) => Number(c.close_price));
  const highs = sorted.map((c) => Number(c.high_price));
  const lows = sorted.map((c) => Number(c.low_price));

  for (let i = 0; i < sorted.length; i += 1) {
    if (![closes[i], highs[i], lows[i]].every(Number.isFinite)) {
      throw new Error(`Invalid OHLC input at candle index ${i}`);
    }
    if (i > 0 && Date.parse(sorted[i].open_time) <= Date.parse(sorted[i - 1].open_time)) {
      throw new Error("Candle open_time values must be unique and increasing.");
    }
  }

  const closeRsi = wilderRsi(closes, length).map((v) => v === null ? null : v - 50);
  const highRsiRaw = wilderRsi(highs, length).map((v) => v === null ? null : v - 50);
  const lowRsiRaw = wilderRsi(lows, length).map((v) => v === null ? null : v - 50);

  const results = [];
  const haOpen = Array(sorted.length).fill(null);
  const haClose = Array(sorted.length).fill(null);

  for (let i = 0; i < sorted.length; i += 1) {
    const rsiOpen = closeRsi[i - 1] ?? closeRsi[i];
    const rsiHigh = maxDefined(highRsiRaw[i], lowRsiRaw[i]);
    const rsiLow = minDefined(highRsiRaw[i], lowRsiRaw[i]);

    if ([rsiOpen, rsiHigh, rsiLow, closeRsi[i]].every(Number.isFinite)) {
      haClose[i] = (rsiOpen + rsiHigh + rsiLow + closeRsi[i]) / 4;
    }

    const smoothingLookbackIsNa = i - openSmoothing < 0 || haOpen[i - openSmoothing] === null;
    if (smoothingLookbackIsNa) {
      haOpen[i] = [rsiOpen, closeRsi[i]].every(Number.isFinite)
        ? (rsiOpen + closeRsi[i]) / 2
        : null;
    } else if (haOpen[i - 1] !== null && haClose[i - 1] !== null) {
      haOpen[i] = ((haOpen[i - 1] * openSmoothing) + haClose[i - 1]) / (openSmoothing + 1);
    }

    const haHigh = maxDefined(rsiHigh, haOpen[i], haClose[i]);
    const haLow = minDefined(rsiLow, haOpen[i], haClose[i]);

    results.push({
      symbol: sorted[i].symbol,
      open_time: sorted[i].open_time,
      close_time: sorted[i].close_time,
      rsi_open: finiteOrNull(rsiOpen),
      rsi_high: finiteOrNull(rsiHigh),
      rsi_low: finiteOrNull(rsiLow),
      rsi_close: finiteOrNull(closeRsi[i]),
      ha_open: finiteOrNull(haOpen[i]),
      ha_high: finiteOrNull(haHigh),
      ha_low: finiteOrNull(haLow),
      ha_close: finiteOrNull(haClose[i]),
      scan_match: haClose[i] !== null && haClose[i] > threshold,
      calculation_version: HARSI_CALCULATION_VERSION
    });
  }

  return results;
}
