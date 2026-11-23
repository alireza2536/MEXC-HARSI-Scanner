import { config, validateConfig } from "./config.js";
import { MexcClient } from "./mexc-client.js";
import { createStore } from "./supabase-store.js";

const log = (event, details = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
};

async function main() {
  validateConfig();

  const mexc = new MexcClient();
  const store = createStore();

  const serverNowMs = await mexc.getServerTimeMs();
  const serverNowSeconds = Math.floor(serverNowMs / 1000);
  const currentCandleOpen = Math.floor(serverNowSeconds / config.intervalSeconds) * config.intervalSeconds;
  const latestClosedOpen = currentCandleOpen - config.intervalSeconds;
  const startSeconds = latestClosedOpen - (config.historyDays * 24 * 60 * 60) + config.intervalSeconds;
  const endSeconds = latestClosedOpen;

  log("scan_started", {
    timeframe: config.interval,
    maxPriceUsdt: config.maxPrice,
    historyDays: config.historyDays,
    startSeconds,
    endSeconds
  });

  const contracts = await mexc.getEligibleUsdtContracts(config.maxPrice);
  log("eligible_contracts_loaded", { count: contracts.length });

  let stored = 0;
  let failed = 0;

  for (const contract of contracts) {
    try {
      const candles = await mexc.get15mCandles(contract.symbol, startSeconds, endSeconds);
      const closedCandles = candles.filter((candle) => {
        const closeMs = Date.parse(candle.close_time);
        return closeMs <= serverNowMs && Date.parse(candle.open_time) <= latestClosedOpen * 1000;
      });

      if (closedCandles.length) {
        await store.upsertCandles(closedCandles);
        stored += closedCandles.length;
      }

      log("contract_processed", {
        symbol: contract.symbol,
        lastPrice: contract.lastPrice,
        received: candles.length,
        stored: closedCandles.length
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
    failedContracts: failed,
    retentionCutoff: cutoffIso
  });

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  log("scan_fatal", { error: error.message });
  process.exitCode = 1;
});
