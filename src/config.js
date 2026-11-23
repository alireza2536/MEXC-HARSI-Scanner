const numberFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("Invalid numeric environment variable: " + name);
  return value;
};

export const config = {
  mexcBaseUrl: (process.env.MEXC_BASE_URL || "https://contract.mexc.com").replace(/\/$/, ""),
  interval: process.env.TIMEFRAME || "Min15",
  intervalSeconds: 15 * 60,
  maxPrice: numberFromEnv("MAX_PRICE_USDT", 30),
  historyDays: numberFromEnv("HISTORY_DAYS", 3),
  requestSpacingMs: numberFromEnv("MEXC_REQUEST_SPACING_MS", 125),
  upsertBatchSize: numberFromEnv("UPSERT_BATCH_SIZE", 500),
  harsiLength: 200,
  harsiOpenSmoothing: 1,
  harsiThreshold: 5.5,
  // MEXC returns at most 2,000 candles per kline request.
  // Only the final 288 candles are retained in the database.
  harsiWarmupCandles: 2000,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
};

export function validateConfig() {
  if (config.interval !== "Min15") throw new Error("This project currently supports only Min15.");
  if (config.maxPrice <= 0) throw new Error("MAX_PRICE_USDT must be greater than zero.");
  if (config.historyDays !== 3) throw new Error("HISTORY_DAYS is fixed at 3 for this project.");
  if (config.harsiLength !== 200 || config.harsiOpenSmoothing !== 1 || config.harsiThreshold !== 5.5) {
    throw new Error("HARSI settings are fixed to the recovered Pine Script specification.");
  }
  if (config.harsiWarmupCandles > 2000 || config.harsiWarmupCandles < 488) {
    throw new Error("HARSI warm-up candle count must be between 488 and 2000.");
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
}
