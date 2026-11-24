import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { config } from "../src/config.js";
import { MexcClient } from "../src/mexc-client.js";
import { runLocalHarsiScan } from "../src/local-scanner.js";
import { createLocalSqliteStore } from "../src/local-sqlite-store.js";

const DATABASE_NAME = "harsi_local";
const CANDLE_INTERVAL_MS = 15 * 60 * 1000;
const NEXT_SCAN_GRACE_MS = 5000;

function makeAbortError() {
  return new DOMException("Scan was stopped because the app left the foreground.", "AbortError");
}

export async function startAndroidLocalApp({ onStatus } = {}) {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("Local SQLite mode is available only inside the Android app.");
  }

  const sqlite = new SQLiteConnection(CapacitorSQLite);
  await sqlite.checkConnectionsConsistency();
  const connectionStatus = await sqlite.isConnection(DATABASE_NAME, false);
  const db = connectionStatus.result
    ? await sqlite.retrieveConnection(DATABASE_NAME, false)
    : await sqlite.createConnection(DATABASE_NAME, false, "no-encryption", 1, false);
  const isOpen = await db.isDBOpen();
  if (!isOpen.result) await db.open();

  const store = createLocalSqliteStore(db);
  await store.initialize();
  let isForeground = false;
  let running = false;
  let timer = null;
  let controller = null;
  let lastSummary = null;
  let lastError = null;
  let activeJob = "idle";
  let completedAt = null;

  const savedRows = await store.getLatestHarsiResults(2000);
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
        haClose: row.ha_close === null || row.ha_close === undefined ? null : Number(row.ha_close),
        candleOpenTime: row.open_time
      }))
    };
    completedAt = lastSummary.completedAt;
  }


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

  function clearScheduledScan() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNextScan() {
    clearScheduledScan();
    if (!isForeground) return;
    const now = Date.now();
    const nextBoundary = (Math.floor(now / CANDLE_INTERVAL_MS) + 1) * CANDLE_INTERVAL_MS;
    const delay = Math.max(1000, nextBoundary + NEXT_SCAN_GRACE_MS - now);
    timer = setTimeout(() => {
      timer = null;
      void runScan();
    }, delay);
  }

  async function runScan() {
    if (!isForeground || running) return;
    running = true;
    controller = new AbortController();
    activeJob = "running";
    lastError = null;
    publish();

    try {
      const summary = await runLocalHarsiScan({
        mexc: new MexcClient({ signal: controller.signal }),
        store,
        maxPrice: config.maxPrice,
        signal: controller.signal,
        onProgress: (progress) => {
          if (isForeground && !controller?.signal.aborted) {
            onStatus?.({ ...getStatus(), progress });
          }
        }
      });
      if (!isForeground || controller.signal.aborted) throw makeAbortError();
      lastSummary = summary;
      completedAt = summary.completedAt;
      activeJob = "completed";
      lastError = null;
    } catch (error) {
      if (error.name === "AbortError" || controller.signal.aborted || !isForeground) {
        activeJob = "paused";
      } else {
        activeJob = "failed";
        lastError = error.message || String(error);
      }
    } finally {
      running = false;
      controller = null;
      publish();
      if (isForeground) scheduleNextScan();
    }
  }

  async function setForeground(active) {
    isForeground = active;
    if (!active) {
      clearScheduledScan();
      if (controller && !controller.signal.aborted) controller.abort();
      if (!running) activeJob = "paused";
      publish();
      return;
    }
    if (!running) await runScan();
  }

  await App.addListener("appStateChange", ({ isActive }) => {
    void setForeground(Boolean(isActive));
  });

  const appState = await App.getState();
  await setForeground(Boolean(appState.isActive));

  return {
    getStatus,
    async refreshNow() {
      if (!isForeground) throw new Error("برای اسکن، برنامه باید در پیش‌زمینه باز باشد.");
      clearScheduledScan();
      if (running) return getStatus();
      await runScan();
      return getStatus();
    },
    async close() {
      isForeground = false;
      clearScheduledScan();
      if (controller && !controller.signal.aborted) controller.abort();
      await App.removeAllListeners();
      await db.close();
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
