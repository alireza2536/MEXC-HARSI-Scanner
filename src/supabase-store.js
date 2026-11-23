import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export function createStore() {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return {
    async upsertCandles(rows) {
      for (let offset = 0; offset < rows.length; offset += config.upsertBatchSize) {
        const batch = rows.slice(offset, offset + config.upsertBatchSize);
        const { error } = await client
          .from("mexc_harsi_15m")
          .upsert(batch, { onConflict: "symbol,open_time" });
        if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
      }
    },

    async deleteExpired(cutoffIso) {
      const { error } = await client
        .from("mexc_harsi_15m")
        .delete()
        .lt("close_time", cutoffIso);
      if (error) throw new Error(`Supabase retention cleanup failed: ${error.message}`);
    }
  };
}
