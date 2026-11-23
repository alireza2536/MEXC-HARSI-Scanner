import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export function createStore() {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true }
  });

  pool.on("error", (error) => {
    console.error(JSON.stringify({ event: "postgres_pool_error", error: error.message }));
  });

  return {
    async upsertCandles(rows) {
      const columns = [
        "symbol", "open_time", "close_time", "open_price",
        "high_price", "low_price", "close_price", "volume", "amount"
      ];
      for (let offset = 0; offset < rows.length; offset += config.upsertBatchSize) {
        const batch = rows.slice(offset, offset + config.upsertBatchSize);
        const values = [];
        const tuples = batch.map((row, rowIndex) => {
          const placeholders = columns.map((column, columnIndex) => {
            values.push(row[column]);
            return `$${rowIndex * columns.length + columnIndex + 1}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        const sql = `
          INSERT INTO public.mexc_futures_ohlcv_15m
            (${columns.join(", ")})
          VALUES ${tuples.join(", ")}
          ON CONFLICT (symbol, open_time) DO UPDATE SET
            close_time = EXCLUDED.close_time,
            open_price = EXCLUDED.open_price,
            high_price = EXCLUDED.high_price,
            low_price = EXCLUDED.low_price,
            close_price = EXCLUDED.close_price,
            volume = EXCLUDED.volume,
            amount = EXCLUDED.amount,
            updated_at = now()
        `;
        await pool.query(sql, values);
      }
    },

    async upsertHarsi(rows) {
      const columns = [
        "symbol", "open_time", "close_time",
        "rsi_open", "rsi_high", "rsi_low", "rsi_close",
        "ha_open", "ha_high", "ha_low", "ha_close",
        "scan_match", "calculation_version"
      ];
      for (let offset = 0; offset < rows.length; offset += config.upsertBatchSize) {
        const batch = rows.slice(offset, offset + config.upsertBatchSize);
        const values = [];
        const tuples = batch.map((row, rowIndex) => {
          const placeholders = columns.map((column, columnIndex) => {
            values.push(row[column]);
            return `$${rowIndex * columns.length + columnIndex + 1}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        const sql = `
          INSERT INTO public.mexc_harsi_results_15m
            (${columns.join(", ")})
          VALUES ${tuples.join(", ")}
          ON CONFLICT (symbol, open_time) DO UPDATE SET
            close_time = EXCLUDED.close_time,
            rsi_open = EXCLUDED.rsi_open,
            rsi_high = EXCLUDED.rsi_high,
            rsi_low = EXCLUDED.rsi_low,
            rsi_close = EXCLUDED.rsi_close,
            ha_open = EXCLUDED.ha_open,
            ha_high = EXCLUDED.ha_high,
            ha_low = EXCLUDED.ha_low,
            ha_close = EXCLUDED.ha_close,
            scan_match = NULL,
            calculation_version = EXCLUDED.calculation_version,
            updated_at = now()
        `;
        await pool.query(sql, values);
      }
    },

    async deleteExpired(cutoffIso) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM public.mexc_harsi_results_15m WHERE close_time < $1",
          [cutoffIso]
        );
        await client.query(
          "DELETE FROM public.mexc_futures_ohlcv_15m WHERE close_time < $1",
          [cutoffIso]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Neon retention cleanup failed: ${error.message}`);
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    }
  };
}
