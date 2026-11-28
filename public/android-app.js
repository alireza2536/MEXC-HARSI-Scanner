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

const scanDiagnostics = {
  clicks: 0,
  lastClick: "هنوز کلیکی ثبت نشده",
  lock: "نامشخص",
  service: "هنوز فراخوانی نشده",
  result: "در انتظار"
};

function updateScanDiagnostics(patch = {}) {
  Object.assign(scanDiagnostics, patch);
  const panel = document.getElementById("harsiScanDiagnostics");
  if (!panel) return;
  for (const [key, value] of Object.entries({
    click: scanDiagnostics.lastClick,
    lock: scanDiagnostics.lock,
    service: scanDiagnostics.service,
    result: scanDiagnostics.result
  })) {
    const target = panel.querySelector(`[data-diagnostic="${key}"]`);
    if (target) target.textContent = value;
  }
}

function installScanDiagnostics() {
  if (document.getElementById("harsiScanDiagnostics")) return;
  const refreshButton = document.getElementById("refresh");
  if (!refreshButton) return;
  const panel = document.createElement("details");
  panel.id = "harsiScanDiagnostics";
  panel.style.cssText = "margin:10px auto 0;max-width:420px;border:1px solid #354862;border-radius:10px;background:#0b1422;color:#cbd5e1;font:12px Tahoma,Arial,sans-serif;text-align:center;overflow:hidden";
  const summary = document.createElement("summary");
  summary.textContent = "گزارش عیب‌یابی اسکن";
  summary.style.cssText = "padding:10px;cursor:pointer;color:#93c5fd;font-weight:700";
  panel.append(summary);
  const rows = [
    ["click", "آخرین کلیک"],
    ["lock", "قفل اسکن قبلی"],
    ["service", "سرویس اندروید"],
    ["result", "نتیجه"]
  ];
  for (const [key, label] of rows) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-top:1px solid #26364d";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("strong");
    value.dataset.diagnostic = key;
    value.style.cssText = "direction:rtl;text-align:left;overflow-wrap:anywhere;font-weight:500;color:#e5edf8";
    row.append(name, value);
    panel.append(row);
  }
  const note = document.createElement("p");
  note.textContent = "این گزارش فقط وضعیت شروع اسکن را ثبت می‌کند و محاسبات اسکن را تغییر نمی‌دهد.";
  note.style.cssText = "margin:8px;padding:0 8px 6px;color:#94a3b8;line-height:1.7";
  panel.append(note);
  const noteAnchor = refreshButton.parentElement?.querySelector(".refresh-note");
  (noteAnchor || refreshButton).insertAdjacentElement("afterend", panel);
  refreshButton.addEventListener("click", () => {
    scanDiagnostics.clicks += 1;
    updateScanDiagnostics({
      lastClick: `دریافت شد (شماره ${scanDiagnostics.clicks})`,
      result: "در حال بررسی"
    });
  }, true);
  updateScanDiagnostics();
}

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
  installScanDiagnostics();
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
    const savedRows = (await Promise.all(["Min5", "Min15", "Min60"].map(async (timeframe) =>
      (await store.getLatestHarsiResults(2000, timeframe)).map((row) => ({ ...row, timeframe }))
    ))).flat();
    const savedFourHourRows = (await store.getLatestVwap4hResults(2000)).map((row) => ({
      symbol: row.symbol,
      timeframe: "Min240",
      candleClose: row.close_price === null || row.close_price === undefined ? null : Number(row.close_price),
      previousCandleClose: row.previous_close_price === null || row.previous_close_price === undefined
        ? null : Number(row.previous_close_price),
      vwapDaily: row.vwap_daily === null || row.vwap_daily === undefined ? null : Number(row.vwap_daily),
      candleOpenTime: row.close_time
    }));
    if (savedRows.length || savedFourHourRows.length) {
      lastSummary = {
        eligibleContracts: Math.max(savedRows.length, savedFourHourRows.length),
        updatedContracts: Math.max(savedRows.length, savedFourHourRows.length),
        failedContracts: 0,
        historyCacheHits: 0,
        historyBackfills: 0,
        candleOpenTime: savedRows[0]?.open_time || savedFourHourRows[0]?.candleOpenTime,
        completedAt: savedRows[0]?.close_time || savedFourHourRows[0]?.candleOpenTime,
        results: [
          ...savedRows.map((row) => ({
            symbol: row.symbol,
            timeframe: row.timeframe,
            haClose: row.ha_close === null || row.ha_close === undefined ? null : Number(row.ha_close),
            vwapDaily: row.vwap_daily === null || row.vwap_daily === undefined ? null : Number(row.vwap_daily),
            candleClose: row.close_price === null || row.close_price === undefined ? null : Number(row.close_price),
            previousCandleClose: row.previous_close_price === null || row.previous_close_price === undefined
              ? null : Number(row.previous_close_price),
            candleOpenTime: row.open_time
          })),
          ...savedFourHourRows
        ]
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
    if (running) {
      updateScanDiagnostics({ lock: "فعال؛ اجرای دوباره مسدود شد", result: "قفل داخلی مانع شروع شد" });
      return;
    }
    running = true;
    controller = new AbortController();
    activeJob = "running";
    lastError = null;
    currentProgress = null;
    publish();

    try {
      const requestLimiter = createMexcRequestLimiter();
      const dailyVwapCache = new Map();
      const progressByTimeframe = new Map();
      const sharedMexc = new MexcClient({ signal: controller.signal, requestLimiter });

      // Report the preparation stage immediately, then fetch server time and the
      // eligible market universe once for every selected timeframe.
      currentProgress = { stage: "preparing", processed: 0, total: 0, remaining: 0, updated: 0, failed: 0, errors: [], errorCounts: {}, results: [] };
      publish();
      const serverNowMs = await sharedMexc.getServerTimeMs();
      if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
      const eligibleContracts = await sharedMexc.getEligibleUsdtContracts(config.maxPrice);
      if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
      currentProgress = {
        stage: "scanning", processed: 0, total: eligibleContracts.length,
        remaining: eligibleContracts.length, updated: 0, failed: 0, errors: [], errorCounts: {}, results: []
      };
      publish();

      const outcomes = await Promise.allSettled(timeframes.map(async (timeframe) => {
        if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
        return runLocalHarsiScan({
          mexc: sharedMexc,
          store,
          maxPrice: config.maxPrice,
          nowMs: serverNowMs,
          eligibleContracts,
          signal: controller.signal,
          timeframe,
          workerCount: timeframes.length > 1 ? 3 : 25,
          dailyVwapCache,
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
              skipped: Math.max(total.skipped, Number(item.skipped) || 0),
              errors: [...total.errors, ...(item.errors || [])],
              errorCounts: Object.fromEntries([...new Set([...Object.keys(total.errorCounts), ...Object.keys(item.errorCounts || {})])]
                .map((key) => [key, (total.errorCounts[key] || 0) + (Number(item.errorCounts?.[key]) || 0)])),
              results: [...total.results, ...(item.results || [])]
            }), { processed: 0, total: 0, remaining: 0, updated: 0, failed: 0, skipped: 0, errors: [], errorCounts: {}, results: [] });
            const uniqueErrors = [...new Map(combined.errors.map((item) =>
              [String(item.timeframe) + "|" + String(item.symbol).toUpperCase() + "|" + (item.stage || "scan"), item]
            )).values()];
            currentProgress = { stage: "scanning", ...combined, errors: uniqueErrors, timeframes: [...progressByTimeframe.keys()] };
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
      // of 15m must not discard previously saved 1h or 5m values from the UI.
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
          (Number(item.updatedContracts) || 0) + (Number(item.failedContracts) || 0) + (Number(item.skippedContracts) || 0)
        )),
        updatedContracts: summaries.reduce((sum, item) => sum + item.updatedContracts, 0),
        failedContracts: Math.max(0, ...summaries.map((item) => Number(item.failedContracts) || 0)),
        skippedContracts: Math.max(0, ...summaries.map((item) => Number(item.skippedContracts) || 0)),
        errors: [...new Map(summaries.flatMap((item) => item.errors || []).map((item) =>
          [String(item.timeframe) + "|" + String(item.symbol).toUpperCase() + "|" + (item.stage || "scan"), item]
        )).values()].slice(0, 100),
        errorCounts: summaries.reduce((counts, item) => {
          for (const [category, count] of Object.entries(item.errorCounts || {})) {
            counts[category] = (counts[category] || 0) + (Number(count) || 0);
          }
          return counts;
        }, {}),
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
      updateScanDiagnostics({
        lock: "آزاد؛ اسکن قبلی پایان یافته",
        result: activeJob === "completed" ? "اسکن کامل شد" : activeJob === "paused" ? "اسکن متوقف شد" : lastError || "اسکن ناموفق بود"
      });
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
      updateScanDiagnostics({ lock: running ? "فعال؛ شروع جدید مسدود شد" : "آزاد؛ اجازه شروع دارد", result: "در حال بررسی درخواست" });
      if (running) {
        updateScanDiagnostics({ result: "درخواست به‌علت قفل اسکن قبلی اجرا نشد" });
        return getStatus();
      }
      const selected = [...new Set(timeframes)].filter((value) => ["Min5", "Min15", "Min60"].includes(value));
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
        updateScanDiagnostics({ service: "در حال ارسال فرمان شروع" });
        await BackgroundScan.start();
        serviceStarted = true;
        updateScanDiagnostics({ service: "فرمان شروع با موفقیت ارسال شد", result: "اسکن در حال آغاز" });
        await runScan(selected);
        return getStatus();
      } catch (error) {
        updateScanDiagnostics({
          service: serviceStarted ? "سرویس شروع شد؛ خطا هنگام اسکن" : "شروع سرویس ناموفق: " + (error?.message || String(error)),
          result: error?.message || String(error)
        });
        throw error;
      } finally {
        // Always close the foreground service, including scan failures and
        // unexpected exceptions. A failed coin is already logged by the worker
        // and does not prevent the remaining contracts from being processed.
        if (serviceStarted) {
          await BackgroundScan.stop()
            .then(() => updateScanDiagnostics({ service: "فرمان توقف ارسال شد" }))
            .catch((error) => updateScanDiagnostics({ service: "خطا هنگام توقف: " + (error?.message || String(error)) }));
        }
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
