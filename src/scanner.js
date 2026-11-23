import { config, validateConfig } from "./config.js";
import { MexcClient } from "./mexc-client.js";
import { createStore } from "./supabase-store.js";
import { calculateClosedCandleWindow } from "./candle-window.js";
import { calculateHarsi } from "./harsi.js";

const log = (event, details = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
};

async function main() {
  validateConfig();

  const mexc = new MexcClient();
  const store = createStore();

  const serverNowMs = await mexc.getServerTimeMs();
  const window = calculateClosedCandleWindow(serverNowMs, config.historyDays);
  const { startSeconds, endSeconds, latestClosedOpen } = window;
  const warmupStartSeconds = latestClosedOpen - ((config.harsiWarmupCandles - 1) * config.intervalSeconds);

  log("scan_started", {
    timeframe: config.interval,
    maxPriceUsdt: config.maxPrice,
    historyDays: config.historyDays,
    storedCandlesPerSymbol: 288,
    harsiLength: config.harsiLength,
    harsiOpenSmoothing: config.harsiOpenSmoothing,
    harsiThreshold: config.harsiThreshold,
    warmupCandlesRequested: config.harsiWarmupCandles,
    warmupStartSeconds,
    startSeconds,
    endSeconds
  });

  const contracts = await mexc.getEligibleUsdtContracts(config.maxPrice);
  log("eligible_contracts_loaded", { count: contracts.length });

  let stored = 0;
  let harsiStored = 0;
  let matched = 0;
  let failed = 0;
  let insufficientHistory = 0;

  for (const contract of contracts) {
    try {
      const candles = await mexc.get15mCandles(contract.symbol, warmupStartSeconds, endSeconds);
      const closedCandles = candles
        .filter((candle) => {
          const closeMs = Date.parse(candle.close_time);
          const openSeconds = Date.parse(candle.open_time) / 1000;
          return closeMs <= serverNowMs && openSeconds <= latestClosedOpen;
        })
        .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));

      const retainedCandles = closedCandles
        .filter((candle) => Date.parse(candle.open_time) / 1000 >= startSeconds)
        .slice(-288);

      if (retainedCandles.length) {
        await store.upsertCandles(retainedCandles);
        stored += retainedCandles.length;
      }

      const calculated = calculateHarsi(closedCandles, {
        length: config.harsiLength,
        openSmoothing: config.harsiOpenSmoothing,
        threshold: config.harsiThreshold
      });
      const retainedTimes = new Set(retainedCandles.map((candle) => candle.open_time));
      const retainedResults = calculated.filter((result) =>
        retainedTimes.has(result.open_time) && result.ha_close !== null
      );

      if (retainedResults.length) {
        await store.upsertHarsi(retainedResults);
        harsiStored += retainedResults.length;
        matched += retainedResults.filter((result) => result.scan_match).length;
      } else if (retainedCandles.length && closedCandles.length < config.harsiLength + 1) {
        insufficientHistory += 1;
      }

      log("contract_processed", {
        symbol: contract.symbol,
        lastPrice: contract.lastPrice,
        warmupReceived: candles.length,
        closedWarmupCandles: closedCandles.length,
        storedCandles: retainedCandles.length,
        harsiRowsStored: retainedResults.length,
        matches: retainedResults.filter((result) => result.scan_match).length
      });
    } catch (error) {
      failed += 1;
      log("contract_failed", { symbol: contract.symbol, error: error.message });
    }
  }

  const cutoffIso = new Date(serverNowMs - config.historyDays * 24 * 60 * 60 * 1000).toISOString();
  await store.deleteExpired(cutoffIso);

  log("scan_completed", {
    eligibleContracts: contracts.length,
    storedCandles: stored,
    harsiRowsStored: harsiStored,
    matchingCandles: matched,
    insufficientHistoryContracts: insufficientHistory,
    failedContracts: failed,
    retentionCutoff: cutoffIso
  });

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  log("scan_fatal", { error: error.message });
  process.exitCode = 1;
});
