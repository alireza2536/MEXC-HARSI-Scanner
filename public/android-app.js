import { Capacitor } from "@capacitor/core";
import { registerPlugin } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { config } from "../src/config.js";
import { MexcClient } from "../src/mexc-client.js";
import { runLocalHarsiScan } from "../src/local-scanner.js";
import { createLocalSqliteStore } from "../src/local-sqlite-store.js";

const DATABASE_NAME = "harsi_local";
const BackgroundScan = registerPlugin("BackgroundScan");

export async function startAndroidLocalApp({ onStatus } = {}) {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("Local SQLite mode is available only inside the Android app.");
  }

  const sqlite = new SQLiteConnection(CapacitorSQLite);
  let db = null;
  let store = null;

  async function openStore() {
    await sqlite.checkConnectionsConsistency();
    const connectionStatus = await sqlite.isConnection(DATABASE_NAME, false);
    db = connectionStatus.result
      ? await sqlite.retrieveConnection(DATABASE_NAME, false)
      : await sqlite.createConnection(DATABASE_NAME, false, "no-encryption", 1, false);
    const isOpen = await db.isDBOpen();
    if (!isOpen.result) await db.open();
    // Give SQLite time to wait for short-lived readers/writers instead of
    // failing immediately with SQLITE_BUSY / SQLITE_LOCKED.
    // PRAGMA busy_timeout returns a row on Android, so it must use query/rawQuery, not execute.
    await db.query("PRAGMA busy_timeout = 10000;");
    store = createLocalSqliteStore(db);
    await store.initialize();
  }

  await openStore();
  let running = false;
  let controller = null;

  let lastSummary = null;
  let lastError = null;
  let activeJob = "idle";
  let completedAt = null;

  async function loadSavedRows() {
    const savedRows = (await Promise.all(["Min1", "Min15"].map(async (timeframe) =>
      (await store.getLatestHarsiResults(2000, timeframe)).map((row) => ({ ...row, timeframe }))
    ))).flat();
    if (savedRows.length) {
      lastSummary = {
        eligibleContracts: savedRows.length,
        updatedContracts: savedRows.length,
        failedContracts: 0,
        historyCacheHits: 0,
        historyBackfills: 0,
        candleOpenTime: savedRows[0].open_time,
        completedAt: savedRows[0].close_time,
        results: savedRows.map((row) => ({
          symbol: row.symbol,
          timeframe: row.timeframe,
          haClose: row.ha_close === null || row.ha_close === undefined ? null : Number(row.ha_close),
          candleOpenTime: row.open_time
        }))
      };
      completedAt = lastSummary.completedAt;
    } else {
      lastSummary = null;
      completedAt = null;
    }
  }

  await loadSavedRows();

  function getStatus() {
    return {
      status: activeJob,
      startedAt: null,
      finishedAt: completedAt,
      error: lastError,
      summary: lastSummary
    };
  }

  function publish() {
    onStatus?.(getStatus());
  }

  async function runScan(timeframes) {
    if (running) return;
    running = true;
    controller = new AbortController();
    activeJob = "running";
    lastError = null;
    publish();

    try {
      const summaries = [];
      for (const timeframe of timeframes) {
        if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
        const summary = await runLocalHarsiScan({
          mexc: new MexcClient({ signal: controller.signal }),
          store,
          maxPrice: config.maxPrice,
          signal: controller.signal,
          timeframe,
          onProgress: (progress) => {
          if (!controller?.signal.aborted) {
            onStatus?.({ ...getStatus(), progress: { ...progress, timeframe } });
            if (progress.processed === 1 || progress.processed % 5 === 0 || progress.processed === progress.total) {
              void BackgroundScan.update({
                message: `${timeframe === "Min1" ? "۱ دقیقه" : "۱۵ دقیقه"} — پردازش ${progress.processed} از ${progress.total} ارز`,
                processed: progress.processed,
                total: progress.total
              }).catch(() => {});
            }
          }
        }
        });
        summaries.push(summary);
      }
      if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
      lastSummary = {
        eligibleContracts: summaries.reduce((sum, item) => sum + item.eligibleContracts, 0),
        updatedContracts: summaries.reduce((sum, item) => sum + item.updatedContracts, 0),
        failedContracts: summaries.reduce((sum, item) => sum + item.failedContracts, 0),
        completedAt: new Date().toISOString(),
        results: summaries.flatMap((item, index) => item.results.map((row) => ({ ...row, timeframe: timeframes[index] })))
      };
      completedAt = lastSummary.completedAt;
      activeJob = "completed";
      lastError = null;
    } catch (error) {
      if (error.name === "AbortError" || controller.signal.aborted) {
        activeJob = "paused";
      } else {
        activeJob = "failed";
        lastError = error.message || String(error);
      }
    } finally {
      running = false;
      controller = null;
      publish();
    }
  }

  return {
    getStatus,
    async cancelNow() {
      if (!running || !controller) return getStatus();
      controller.abort();
      await BackgroundScan.stop().catch(() => {});
      return getStatus();
    },
    async refreshNow(timeframes = ["Min15"]) {
      if (running) return getStatus();
      const selected = [...new Set(timeframes)].filter((value) => ["Min1", "Min15"].includes(value));
      if (!selected.length) throw new Error("حداقل یک تایم‌فریم را انتخاب کنید.");
      await BackgroundScan.requestNotificationPermission();
      let serviceStarted = false;
      try {
        await BackgroundScan.start();
        serviceStarted = true;
        await runScan(selected);
        return getStatus();
      } finally {
        // Always close the foreground service, including scan failures and
        // unexpected exceptions. A failed coin is already logged by the worker
        // and does not prevent the remaining contracts from being processed.
        if (serviceStarted) await BackgroundScan.stop().catch(() => {});
      }
    }
  };
}

if (Capacitor.isNativePlatform()) {
  window.localHarsiReady = startAndroidLocalApp({
    onStatus: (job) => window.localHarsiRender?.(job)
  }).then((runtime) => {
    window.localHarsiBridge = runtime;
    window.localHarsiRender?.(runtime.getStatus());
    return runtime;
  }).catch((error) => {
    const failed = {
      status: "failed",
      startedAt: null,
      finishedAt: null,
      error: error.message || String(error),
      summary: null
    };
    window.localHarsiRender?.(failed);
    return {
      getStatus: () => failed,
      async refreshNow() { throw error; }
    };
  });
}
