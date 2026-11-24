const runtimeEnv = typeof process !== "undefined" && process.env
  ? process.env
  : (import.meta.env || {});

const numberFromEnv = (name, fallback) => {
  const raw = runtimeEnv[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric environment variable: ${name}`);
  return value;
};

export const config = {
  mexcBaseUrl: (runtimeEnv.MEXC_BASE_URL || runtimeEnv.VITE_MEXC_BASE_URL || "https://contract.mexc.com").replace(/\/$/, ""),
  interval: runtimeEnv.TIMEFRAME || "Min15",
  intervalSeconds: 15 * 60,
  maxPrice: numberFromEnv("MAX_PRICE_USDT", numberFromEnv("VITE_MAX_PRICE_USDT", 10)),
  historyDays: numberFromEnv("HISTORY_DAYS", 3),
  requestSpacingMs: numberFromEnv("MEXC_REQUEST_SPACING_MS", 125),
  requestTimeoutMs: numberFromEnv("MEXC_REQUEST_TIMEOUT_MS", 25000),
  upsertBatchSize: numberFromEnv("UPSERT_BATCH_SIZE", 500),
  databaseUrl: runtimeEnv.DATABASE_URL
};

export function validateConfig() {
  if (config.interval !== "Min15") throw new Error("This project currently supports only Min15.");
  if (config.maxPrice <= 0) throw new Error("MAX_PRICE_USDT must be greater than zero.");
  if (config.historyDays !== 3) throw new Error("HISTORY_DAYS is fixed at 3 for this project.");
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required (Neon PostgreSQL connection string).");
  }
}
