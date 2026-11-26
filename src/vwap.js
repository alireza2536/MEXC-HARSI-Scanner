function timestampOf(candle){const value=Date.parse(candle?.open_time);return Number.isFinite(value)?value:NaN;}
function weightedVwap(candles){let priceVolume=0,totalVolume=0;for(const candle of candles){const high=Number(candle.high_price),low=Number(candle.low_price),close=Number(candle.close_price),volume=Number(candle.volume);if(![high,low,close,volume].every(Number.isFinite)||volume<=0)continue;priceVolume+=((high+low+close)/3)*volume;totalVolume+=volume;}return totalVolume>0?priceVolume/totalVolume:null;}
/** UTC-session VWAP using typical price (H + L + C) / 3 weighted by volume. */
export function calculateDailyVwap(candles,nowMs=Date.now()){
 if(!Array.isArray(candles))throw new TypeError("VWAP candles must be an array.");
 if(!Number.isFinite(nowMs))throw new TypeError("VWAP calculation time must be a finite timestamp.");
 const ordered=candles.map(candle=>({candle,timestamp:timestampOf(candle)})).filter(item=>Number.isFinite(item.timestamp)&&item.timestamp<=nowMs).sort((a,b)=>a.timestamp-b.timestamp);
 const utcDayStart=new Date(nowMs);utcDayStart.setUTCHours(0,0,0,0);
 const daily=ordered.filter(item=>item.timestamp>=utcDayStart.getTime()).map(item=>item.candle);
 return {vwap_daily:weightedVwap(daily),daily_candle_count:daily.length};
}

/** Validate values shared by VWAP crossing predicates. */
function validCrossValues(previousClose, currentClose, vwap) {
 const validInput = (value) => value !== null && value !== undefined
  && !(typeof value === "string" && value.trim() === "");
 if (![previousClose, currentClose, vwap].every(validInput)) return null;
 const values=[Number(previousClose),Number(currentClose),Number(vwap)];
 return values.every(Number.isFinite)?values:null;
}

/** True only when the previous candle was at/below VWAP and the current candle is above it. */
export function isCrossUp(previousClose, currentClose, vwap) {
 const values=validCrossValues(previousClose,currentClose,vwap);
 return values!==null&&values[0]<=values[2]&&values[1]>values[2];
}

/** True only when the previous candle was at/above VWAP and the current candle is below it. */
export function isCrossDown(previousClose, currentClose, vwap) {
 const values=validCrossValues(previousClose,currentClose,vwap);
 return values!==null&&values[0]>=values[2]&&values[1]<values[2];
}

/**
 * Build two overlapping rolling 4-hour candles from exactly eight consecutive
 * 1-hour candles. The input may be in either order; output is oldest first.
 */
export function aggregateRollingFourHourCandles(candles) {
  if (!Array.isArray(candles) || candles.length !== 8) return [];
  const ordered = [...candles].sort((a, b) => timestampOf(a) - timestampOf(b));
  const timestamps = ordered.map(timestampOf);
  if (timestamps.some((value) => !Number.isFinite(value))) return [];
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] - timestamps[index - 1] !== 3600000) return [];
  }
  const aggregate = (window) => {
    const numeric = window.map((candle) => ({
      open: Number(candle.open_price),
      high: Number(candle.high_price),
      low: Number(candle.low_price),
      close: Number(candle.close_price),
      volume: Number(candle.volume ?? 0),
      amount: Number(candle.amount ?? 0)
    }));
    if (numeric.some((item) => ![item.open, item.high, item.low, item.close, item.volume, item.amount].every(Number.isFinite))) return null;
    return {
      symbol: window[0].symbol,
      open_time: window[0].open_time,
      close_time: window[3].close_time,
      open_price: numeric[0].open,
      high_price: Math.max(...numeric.map((item) => item.high)),
      low_price: Math.min(...numeric.map((item) => item.low)),
      close_price: numeric[3].close,
      volume: numeric.reduce((sum, item) => sum + item.volume, 0),
      amount: numeric.reduce((sum, item) => sum + item.amount, 0)
    };
  };
  const first = aggregate(ordered.slice(0, 4));
  const second = aggregate(ordered.slice(4, 8));
  return first && second ? [first, second] : [];
}
