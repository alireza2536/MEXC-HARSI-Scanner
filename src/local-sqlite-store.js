const DATABASE_NAME = "harsi_local";
const DATABASE_VERSION = 1;
const HISTORY_CANDLES = 2000;
const RESULT_RETENTION_DAYS = 7;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mexc_futures_ohlcv_15m (
    symbol TEXT NOT NULL,
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    open_price REAL NOT NULL,
    high_price REAL NOT NULL,
    low_price REAL NOT NULL,
    close_price REAL NOT NULL,
    volume REAL,
    amount REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, open_time)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_ohlcv_symbol_time
    ON mexc_futures_ohlcv_15m(symbol, open_time DESC)`,
  `CREATE TABLE IF NOT EXISTS mexc_harsi_results_15m (
    symbol TEXT NOT NULL,
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    rsi_open REAL,
    rsi_high REAL,
    rsi_low REAL,
    rsi_close REAL,
    ha_open REAL,
    ha_high REAL,
    ha_low REAL,
    ha_close REAL,
    scan_match INTEGER,
    calculation_version TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, open_time),
    FOREIGN KEY (symbol, open_time)
      REFERENCES mexc_futures_ohlcv_15m(symbol, open_time) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_harsi_time
    ON mexc_harsi_results_15m(close_time DESC)`
];

const CANDLE_COLUMNS = [
  "symbol", "open_time", "close_time", "open_price", "high_price",
  "low_price", "close_price", "volume", "amount"
];
const HARSI_COLUMNS = [
  "symbol", "open_time", "close_time", "rsi_open", "rsi_high", "rsi_low",
  "rsi_close", "ha_open", "ha_high", "ha_low", "ha_close",
  "scan_match", "calculation_version"
];

function valuesFor(row, columns) {
  return columns.map((column) => row[column] ?? null);
}

function upsertStatement(table, columns) {
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns
    .filter((column) => column !== "symbol" && column !== "open_time")
    .map((column) => column + " = excluded." + column)
    .concat("updated_at = CURRENT_TIMESTAMP");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(symbol, open_time) DO UPDATE SET ${updates.join(", ")}`;
}

export function createLocalSqliteStore(sqliteConnection) {
  if (!sqliteConnection || typeof sqliteConnection.execute !== "function"
      || typeof sqliteConnection.run !== "function"
      || typeof sqliteConnection.query !== "function"
      || typeof sqliteConnection.executeSet !== "function") {
    throw new TypeError("A Capacitor SQLite connection is required.");
  }

  let initialized = false;

  async function initialize() {
    if (initialized) return;
    await sqliteConnection.execute("PRAGMA foreign_keys = ON;");
    for (const statement of SCHEMA) await sqliteConnection.execute(statement);
    initialized = true;
  }

  async function upsertMany(statement, rows, columns, batchSize = 100) {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      // Execute one prepared statement per row; the native SQLite plugin
      // binds values safely and avoids constructing SQL from market data.
      for (const row of batch) {
        await sqliteConnection.run(statement, valuesFor(row, columns));
      }
    }
  }

  return {
    databaseName: DATABASE_NAME,
    databaseVersion: DATABASE_VERSION,
    async initialize() {
      await initialize();
    },
    async getHistoricalCandles(symbol, beforeOpenTime, limit = HISTORY_CANDLES) {
      await initialize();
      const result = await sqliteConnection.query(
        `SELECT ${CANDLE_COLUMNS.join(", ")}
         FROM mexc_futures_ohlcv_15m
         WHERE symbol = ? AND open_time < ?
         ORDER BY open_time DESC LIMIT ?`,
        [symbol, beforeOpenTime, Math.min(HISTORY_CANDLES, limit)]
      );
      return (result.values || []).reverse();
    },
    async upsertCandles(rows) {
      await initialize();
      await upsertMany(
        upsertStatement("mexc_futures_ohlcv_15m", CANDLE_COLUMNS),
        rows,
        CANDLE_COLUMNS
      );
    },
    async upsertHarsi(rows) {
      await initialize();
      await upsertMany(
        upsertStatement("mexc_harsi_results_15m", HARSI_COLUMNS),
        rows,
        HARSI_COLUMNS
      );
    },
    async persistCurrentBatch(items) {
      await initialize();
      const candleStatement = upsertStatement("mexc_futures_ohlcv_15m", CANDLE_COLUMNS);
      const harsiStatement = upsertStatement("mexc_harsi_results_15m", HARSI_COLUMNS);
      const operations = [];
      for (const item of items) {
        operations.push({ statement: candleStatement, values: valuesFor(item.current, CANDLE_COLUMNS) });
        operations.push({ statement: harsiStatement, values: valuesFor(item.currentHarsi, HARSI_COLUMNS) });
      }
      if (operations.length) await sqliteConnection.executeSet(operations, true);
    },
    async pruneCandleHistory() {
      await initialize();
      await sqliteConnection.execute(
        `DELETE FROM mexc_futures_ohlcv_15m
         WHERE (symbol, open_time) NOT IN (
           SELECT symbol, open_time FROM (
             SELECT symbol, open_time,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY open_time DESC) AS position
             FROM mexc_futures_ohlcv_15m
           ) ranked WHERE position <= ${HISTORY_CANDLES + 1}
         )`
      );
    },
    async pruneExpiredHarsi(now = new Date()) {
      await initialize();
      const cutoff = new Date(now.getTime() - RESULT_RETENTION_DAYS * 86400000).toISOString();
      await sqliteConnection.run(
        "DELETE FROM mexc_harsi_results_15m WHERE close_time < ?",
        [cutoff]
      );
    },
    async getLatestHarsiResults(limit = 1000) {
      await initialize();
      const result = await sqliteConnection.query(
        `SELECT symbol, open_time, close_time, ha_close, ha_open, ha_high, ha_low,
                rsi_close, scan_match, calculation_version
         FROM mexc_harsi_results_15m
         ORDER BY close_time DESC, symbol ASC LIMIT ?`,
        [limit]
      );
      return result.values || [];
    },
    async close() {
      // Connection lifecycle is owned by the Android bridge, not this store.
    }
  };
}

export const LOCAL_STORE_LIMITS = Object.freeze({
  historyCandles: HISTORY_CANDLES,
  resultRetentionDays: RESULT_RETENTION_DAYS
});
