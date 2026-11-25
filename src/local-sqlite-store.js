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
    ON mexc_harsi_results_15m(close_time DESC)`,
  `CREATE TABLE IF NOT EXISTS mexc_futures_ohlcv_1m (
    symbol TEXT NOT NULL, open_time TEXT NOT NULL, close_time TEXT NOT NULL,
    open_price REAL NOT NULL, high_price REAL NOT NULL, low_price REAL NOT NULL,
    close_price REAL NOT NULL, volume REAL, amount REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, open_time)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_ohlcv_1m_symbol_time
    ON mexc_futures_ohlcv_1m(symbol, open_time DESC)`,
  `CREATE TABLE IF NOT EXISTS mexc_harsi_results_1m (
    symbol TEXT NOT NULL, open_time TEXT NOT NULL, close_time TEXT NOT NULL,
    rsi_open REAL, rsi_high REAL, rsi_low REAL, rsi_close REAL,
    ha_open REAL, ha_high REAL, ha_low REAL, ha_close REAL,
    scan_match INTEGER, calculation_version TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, open_time),
    FOREIGN KEY (symbol, open_time)
      REFERENCES mexc_futures_ohlcv_1m(symbol, open_time) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_harsi_1m_time
    ON mexc_harsi_results_1m(close_time DESC)`,
  `CREATE TABLE IF NOT EXISTS mexc_futures_ohlcv_1h (
    symbol TEXT NOT NULL, open_time TEXT NOT NULL, close_time TEXT NOT NULL,
    open_price REAL NOT NULL, high_price REAL NOT NULL, low_price REAL NOT NULL,
    close_price REAL NOT NULL, volume REAL, amount REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, open_time)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_ohlcv_1h_symbol_time
    ON mexc_futures_ohlcv_1h(symbol, open_time DESC)`,
  `CREATE TABLE IF NOT EXISTS mexc_harsi_results_1h (
    symbol TEXT NOT NULL, open_time TEXT NOT NULL, close_time TEXT NOT NULL,
    rsi_open REAL, rsi_high REAL, rsi_low REAL, rsi_close REAL,
    ha_open REAL, ha_high REAL, ha_low REAL, ha_close REAL,
    scan_match INTEGER, calculation_version TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, open_time),
    FOREIGN KEY (symbol, open_time)
      REFERENCES mexc_futures_ohlcv_1h(symbol, open_time) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_harsi_1h_time
    ON mexc_harsi_results_1h(close_time DESC)`,
  `CREATE TABLE IF NOT EXISTS mexc_vwap_values (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time TEXT NOT NULL,
    vwap_daily REAL,
    daily_candle_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, timeframe, open_time)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_vwap_latest
    ON mexc_vwap_values(symbol, timeframe, open_time DESC)`
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

function tablesFor(timeframe = "Min15") {
  if (timeframe === "Min1") return { candles: "mexc_futures_ohlcv_1m", harsi: "mexc_harsi_results_1m" };
  if (timeframe === "Min15") return { candles: "mexc_futures_ohlcv_15m", harsi: "mexc_harsi_results_15m" };
  if (timeframe === "Min60") return { candles: "mexc_futures_ohlcv_1h", harsi: "mexc_harsi_results_1h" };
  throw new Error(`Unsupported timeframe: ${timeframe}`);
}

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
  let initializationPromise = null;
  let writeQueue = Promise.resolve();

  function serializeWrite(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => {});
    return result;
  }

  async function initialize() {
    if (initialized) return;
    if (!initializationPromise) {
      initializationPromise = (async () => {
        await sqliteConnection.query("PRAGMA foreign_keys = ON;");
        for (const statement of SCHEMA) await sqliteConnection.execute(statement);
        // Rebuild legacy VWAP storage once, dropping rolling VWAP values while preserving daily history.
        const vwapColumns = await sqliteConnection.query("PRAGMA table_info(mexc_vwap_values);");
        if ((vwapColumns.values || []).some((column) => column.name === "vwap_rolling")) {
          await sqliteConnection.execute(`CREATE TABLE mexc_vwap_values_daily (
            symbol TEXT NOT NULL, timeframe TEXT NOT NULL, open_time TEXT NOT NULL,
            vwap_daily REAL, daily_candle_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, timeframe, open_time)
          )`);
          await sqliteConnection.execute(`INSERT INTO mexc_vwap_values_daily
            (symbol, timeframe, open_time, vwap_daily, daily_candle_count, updated_at)
            SELECT symbol, timeframe, open_time, vwap_daily, daily_candle_count, updated_at
            FROM mexc_vwap_values`);
          await sqliteConnection.execute("DROP TABLE mexc_vwap_values;");
          await sqliteConnection.execute("ALTER TABLE mexc_vwap_values_daily RENAME TO mexc_vwap_values;");
          await sqliteConnection.execute(`CREATE INDEX IF NOT EXISTS idx_local_vwap_latest
            ON mexc_vwap_values(symbol, timeframe, open_time DESC)`);
        }
        initialized = true;
      })().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }
    await initializationPromise;
  }

  async function upsertMany(statement, rows, columns, batchSize = 500) {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      // One native bridge call per bounded batch; SQLite binds every value.
      const operations = batch.map((row) => ({
        statement,
        values: valuesFor(row, columns)
      }));
      if (operations.length) await sqliteConnection.executeSet(operations, true);
    }
  }

  return {
    databaseName: DATABASE_NAME,
    databaseVersion: DATABASE_VERSION,
    async initialize() {
      await initialize();
    },
    async getHistoricalCandles(symbol, beforeOpenTime, limit = HISTORY_CANDLES, timeframe = "Min15") {
      await initialize();
      const tables = tablesFor(timeframe);
      const result = await sqliteConnection.query(
        `SELECT ${CANDLE_COLUMNS.join(", ")}
         FROM ${tables.candles}
         WHERE symbol = ? AND open_time < ?
         ORDER BY open_time DESC LIMIT ?`,
        [symbol, beforeOpenTime, Math.min(HISTORY_CANDLES, limit)]
      );
      return (result.values || []).reverse();
    },
    async upsertCandles(rows, timeframe = "Min15") {
      await initialize();
      await serializeWrite(() => upsertMany(
        upsertStatement(tablesFor(timeframe).candles, CANDLE_COLUMNS),
        rows,
        CANDLE_COLUMNS
      ));
    },
    async upsertHarsi(rows, timeframe = "Min15") {
      await initialize();
      await serializeWrite(() => upsertMany(
        upsertStatement(tablesFor(timeframe).harsi, HARSI_COLUMNS),
        rows,
        HARSI_COLUMNS
      ));
    },
    async persistCurrentBatch(items, timeframe = "Min15") {
      await initialize();
      const tables = tablesFor(timeframe);
      const candleStatement = upsertStatement(tables.candles, CANDLE_COLUMNS);
      const harsiStatement = upsertStatement(tables.harsi, HARSI_COLUMNS);
      const operations = [];
      for (const item of items) {
        operations.push({ statement: candleStatement, values: valuesFor(item.current, CANDLE_COLUMNS) });
        operations.push({ statement: harsiStatement, values: valuesFor(item.currentHarsi, HARSI_COLUMNS) });
        operations.push({
          statement: `INSERT INTO mexc_vwap_values
            (symbol, timeframe, open_time, vwap_daily, daily_candle_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
              vwap_daily = excluded.vwap_daily,
              daily_candle_count = excluded.daily_candle_count,
              updated_at = CURRENT_TIMESTAMP`,
          values: [item.current.symbol, timeframe, item.current.open_time,
            item.currentVwap?.vwap_daily ?? null, item.currentVwap?.daily_candle_count ?? 0]
        });
      }
      if (operations.length) {
        await serializeWrite(() => sqliteConnection.executeSet(operations, true));
      }
    },
    async pruneCandleHistory(timeframe = "Min15") {
      await initialize();
      const tables = tablesFor(timeframe);
      await serializeWrite(() => sqliteConnection.execute(
        `DELETE FROM ${tables.candles}
         WHERE (symbol, open_time) NOT IN (
           SELECT symbol, open_time FROM (
             SELECT symbol, open_time,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY open_time DESC) AS position
             FROM ${tables.candles}
           ) ranked WHERE position <= ${HISTORY_CANDLES + 1}
         )`
      ));
    },
    async pruneExpiredHarsi(now = new Date(), timeframe = "Min15") {
      await initialize();
      const cutoff = new Date(now.getTime() - RESULT_RETENTION_DAYS * 86400000).toISOString();
      const tables = tablesFor(timeframe);
      await serializeWrite(() => sqliteConnection.run(
        `DELETE FROM ${tables.harsi} WHERE close_time < ?`,
        [cutoff]
      ));
    },
    async getLatestHarsiResults(limit = 1000, timeframe = "Min15") {
      await initialize();
      const tables = tablesFor(timeframe);
      const result = await sqliteConnection.query(
        `SELECT latest.symbol, latest.open_time, latest.close_time, latest.ha_close,
                latest.ha_open, latest.ha_high, latest.ha_low, latest.rsi_close,
                latest.scan_match, latest.calculation_version,
                vwap.vwap_daily
         FROM (
           SELECT symbol, open_time, close_time, ha_close, ha_open, ha_high, ha_low,
                  rsi_close, scan_match, calculation_version,
                  ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY open_time DESC) AS position
           FROM ${tables.harsi}
         ) latest
         LEFT JOIN mexc_vwap_values vwap
           ON vwap.symbol = latest.symbol AND vwap.timeframe = ? AND vwap.open_time = latest.open_time
         WHERE latest.position = 1
         ORDER BY latest.close_time DESC, latest.symbol ASC LIMIT ?`,
        [timeframe, limit]
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
