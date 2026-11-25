import { Capacitor } from "@capacitor/core";
import { registerPlugin } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { config } from "../src/config.js";
import { createMexcRequestLimiter, MexcClient } from "../src/mexc-client.js";
import { runLocalHarsiScan } from "../src/local-scanner.js";
import { createLocalSqliteStore } from "../src/local-sqlite-store.js";

const DATABASE_NAME = "harsi_local";
const BackgroundScan = registerPlugin("BackgroundScan");

let androidStartupPromise = null;

export function startAndroidLocalApp(options = {}) {
  // Capacitor can re-enter the app bootstrap after a WebView reload. Reuse
  // one startup promise so the same SQLite database is never opened twice.
  if (!androidStartupPromise) {
    androidStartupPromise = startAndroidLocalAppOnce(options).catch((error) => {
      androidStartupPromise = null;
      throw error;
    });
  }
  return androidStartupPromise;
}

async function startAndroidLocalAppOnce({ onStatus } = {}) {
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
    // A previous WebView bootstrap may have left a short-lived native SQLite
    // operation finishing. Do not create a second connection; wait for the
    // existing connection to become available and retry transient SQLITE_BUSY.
    let lastOpenError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const isOpen = await db.isDBOpen();
      if (isOpen.result) {
        lastOpenError = null;
        break;
      }
      try {
        await db.open();
        lastOpenError = null;
        break;
      } catch (error) {
        lastOpenError = error;
        const message = error?.message || String(error);
        if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED|code 5/i.test(message) || attempt === 5) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        await sqlite.checkConnectionsConsistency().catch(() => {});
      }
    }
    if (lastOpenError) throw lastOpenError;
    // Apply a bounded wait to subsequent native reads/writes as well.
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
  // Keep the latest live progress in the authoritative status snapshot. Without
  // this, the 3-second UI poll replaces fresh progress with the previous summary.
  let currentProgress = null;

  async function loadSavedRows() {
    const savedRows = (await Promise.all(["Min1", "Min15", "Min60"].map(async (timeframe) =>
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
      summary: lastSummary,
      progress: currentProgress
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
    currentProgress = null;
    publish();

    try {
      const requestLimiter = createMexcRequestLimiter();
      const progressByTimeframe = new Map();
      const outcomes = await Promise.allSettled(timeframes.map(async (timeframe) => {
        if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
        return runLocalHarsiScan({
          mexc: new MexcClient({ signal: controller.signal, requestLimiter }),
          store,
          maxPrice: config.maxPrice,
          signal: controller.signal,
          timeframe,
          workerCount: timeframes.length > 1 ? 3 : 5,
          onProgress: (progress) => {
            if (controller?.signal.aborted) return;
            progressByTimeframe.set(timeframe, progress);
            const timeframeProgress = [...progressByTimeframe.values()];
            // Both timeframes scan the same currency universe. Progress is a
            // count of distinct currencies, not timeframe-currency tasks.
            const combined = timeframeProgress.reduce((total, item) => ({
              processed: Math.max(total.processed, Number(item.processed) || 0),
              total: Math.max(total.total, Number(item.total) || 0),
              remaining: Math.max(total.remaining, Number(item.remaining) || 0),
              updated: total.updated + (Number(item.updated) || 0),
              failed: Math.max(total.failed, Number(item.failed) || 0),
              results: [...total.results, ...(item.results || [])]
            }), { processed: 0, total: 0, remaining: 0, updated: 0, failed: 0, results: [] });
            currentProgress = { ...combined, timeframes: [...progressByTimeframe.keys()] };
            onStatus?.(getStatus());
            if (progress.processed === 1 || progress.processed % 5 === 0 || progress.processed === progress.total) {
              void BackgroundScan.update({
                message: `پردازش ${combined.processed} از ${combined.total} ارز`,
                processed: combined.processed,
                total: combined.total
              }).catch(() => {});
            }
          }
        });
      }));
      if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
      const failedScan = outcomes.find((outcome) => outcome.status === "rejected");
      if (failedScan) throw failedScan.reason;
      const summaries = outcomes.map((outcome) => outcome.value);
      // Keep the latest saved value for every symbol/timeframe pair. A scan
      // of 15m must not discard previously saved 1h or 1m values from the UI.
      const mergedResults = new Map(
        (lastSummary?.results || []).map((item) => [`${item.timeframe}|${String(item.symbol).toUpperCase()}`, item])
      );
      for (const item of summaries.flatMap((summary) => summary.results)) {
        mergedResults.set(`${item.timeframe}|${String(item.symbol).toUpperCase()}`, item);
      }
      lastSummary = {
        // A currency selected in two timeframes is still one eligible currency.
        eligibleContracts: Math.max(0, ...summaries.map((item) => Number(item.eligibleContracts) || 0)),
        processedContracts: Math.max(0, ...summaries.map((item) =>
          (Number(item.updatedContracts) || 0) + (Number(item.failedContracts) || 0)
        )),
        updatedContracts: summaries.reduce((sum, item) => sum + item.updatedContracts, 0),
        failedContracts: Math.max(0, ...summaries.map((item) => Number(item.failedContracts) || 0)),
        completedAt: new Date().toISOString(),
        results: [...mergedResults.values()]
      };
      completedAt = lastSummary.completedAt;
      activeJob = "completed";
      lastError = null;
      currentProgress = null;
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
      const selected = [...new Set(timeframes)].filter((value) => ["Min1", "Min15", "Min60"].includes(value));
      if (!selected.length) throw new Error("حداقل یک تایم‌فریم را انتخاب کنید.");
      // Notification permission is optional: Android can still run a foreground
      // service when notifications are denied. Never block the market scan on it.
      try {
        await BackgroundScan.requestNotificationPermission();
      } catch (permissionError) {
        console.warn("Harsi notification permission was not granted; continuing scan.", permissionError);
      }
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
        // Publish once more after the native foreground service has stopped.
        // This final authoritative event prevents the UI cancel label from
        // remaining visible if the WebView missed the scan-completion event.
        if (!running) publish();
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

// Native Android TXT export: save directly into the public Downloads/Harsi folder.
window.harsiAndroidExportText = async (content, fileName) => BackgroundScan.saveTextToDownloads({ content, fileName });
