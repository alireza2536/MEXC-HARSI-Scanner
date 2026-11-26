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
