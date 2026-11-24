import { Capacitor } from "@capacitor/core";
import { registerPlugin } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { config } from "../src/config.js";
import { MexcClient } from "../src/mexc-client.js";
import { runLocalHarsiScan } from "../src/local-scanner.js";
import { createLocalSqliteStore } from "../src/local-sqlite-store.js";

const DATABASE_NAME = "harsi_local";
const BackgroundScan = registerPlugin("BackgroundScan");
const HarsiBackupPicker = registerPlugin("HarsiBackupPicker");

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

  async function runScan() {
    if (running) return;
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
          if (!controller?.signal.aborted) {
            onStatus?.({ ...getStatus(), progress });
            if (progress.processed === 1 || progress.processed % 5 === 0 || progress.processed === progress.total) {
              void BackgroundScan.update({
                message: `پردازش ${progress.processed} از ${progress.total} ارز`,
                processed: progress.processed,
                total: progress.total
              }).catch(() => {});
            }
          }
        }
      });
      if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
      lastSummary = summary;
      completedAt = summary.completedAt;
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
    async createBackup() {
      if (running) throw new Error("لطفاً تا پایان اسکن صبر کن و دوباره پشتیبان بگیر.");
      const fileName = "harsi-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      const destination = await HarsiBackupPicker.chooseDestination({ fileName });
      if (destination?.cancelled) return { cancelled: true };
      const exported = await db.exportToJson("full");
      const backup = {
        ...exported,
        database: DATABASE_NAME,
        mode: "full",
        overwrite: true,
        backupCreatedAt: new Date().toISOString(),
        backupFormat: "harsi-local-sqlite-v1"
      };
      await HarsiBackupPicker.writeJson({
        uri: destination.uri,
        data: JSON.stringify(backup)
      });
      return { fileName: destination.fileName || fileName, uri: destination.uri };
    },
    async restoreBackup(jsonString) {
      if (running) throw new Error("هنگام اجرای اسکن نمی‌توان بانک را بازیابی کرد.");
      let backup;
      try { backup = JSON.parse(jsonString); }
      catch { throw new Error("فایل انتخاب‌شده JSON معتبر نیست."); }
      if (!backup || backup.database !== DATABASE_NAME || !Array.isArray(backup.tables) || !backup.tables.length) {
        throw new Error("این فایل، پشتیبان معتبر بانک Harsi نیست.");
      }
      backup.mode = "full";
      backup.overwrite = true;
      await sqlite.closeConnection(DATABASE_NAME, false);
      await sqlite.importFromJson(JSON.stringify(backup));
      await openStore();
      await loadSavedRows();
      activeJob = "completed";
      lastError = null;
      publish();
      return { results: lastSummary?.results?.length || 0 };
    },
    async refreshNow() {
      if (running) return getStatus();
      await BackgroundScan.requestNotificationPermission();
      await BackgroundScan.start();
      try {
        await runScan();
        return getStatus();
      } finally {
        await BackgroundScan.stop();
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
