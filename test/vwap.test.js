import test from "node:test";
import assert from "node:assert/strict";
import { calculateDailyVwap, isCrossUp, isCrossDown } from "../src/vwap.js";
function candle(time,high,low,close,volume){return {open_time:new Date(time).toISOString(),high_price:high,low_price:low,close_price:close,volume};}
test("daily VWAP uses only candles from UTC midnight and includes the current candle",()=>{
 const now=Date.parse("2026-11-25T12:30:00.000Z");
 const rows=[candle("2026-11-24T23:45:00Z",100,90,95,100),candle("2026-11-25T00:00:00Z",10,8,9,2),candle("2026-11-25T12:15:00Z",20,16,18,4),candle("2026-11-25T12:45:00Z",30,24,27,10)];
 const result=calculateDailyVwap(rows,now),p1=(10+8+9)/3,p2=(20+16+18)/3;
 assert.ok(Math.abs(result.vwap_daily-((p1*2+p2*4)/6))<1e-12);assert.equal(result.daily_candle_count,2);assert.equal("vwap_rolling" in result,false);
});
test("daily VWAP returns null when all candle volumes are zero or invalid",()=>{
 const result=calculateDailyVwap([candle("2026-11-25T11:00:00Z",3,2,2,0)],Date.parse("2026-11-25T12:30:00.000Z"));assert.equal(result.vwap_daily,null);assert.equal(result.daily_candle_count,1);
});
test("daily VWAP validates its inputs",()=>{assert.throws(()=>calculateDailyVwap("not-an-array"),TypeError);assert.throws(()=>calculateDailyVwap([],Number.NaN),TypeError);});

test("Cross Up and Cross Down detect directional VWAP crossings",()=>{
 assert.equal(isCrossUp(99,101,100),true);
 assert.equal(isCrossUp(100,101,100),true);
 assert.equal(isCrossUp(101,102,100),false);
 assert.equal(isCrossDown(101,99,100),true);
 assert.equal(isCrossDown(100,99,100),true);
 assert.equal(isCrossDown(99,98,100),false);
});
test("VWAP crossing predicates reject missing, empty, and non-finite values",()=>{
 for(const predicate of [isCrossUp,isCrossDown]){
  assert.equal(predicate(null,99,100),false);
  assert.equal(predicate(101,undefined,100),false);
  assert.equal(predicate(101,99,null),false);
  assert.equal(predicate("",99,100),false);
  assert.equal(predicate(101,Number.NaN,100),false);
 }
});
