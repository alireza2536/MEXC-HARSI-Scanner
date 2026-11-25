import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { fetch as undiciFetch } from "undici";
import { config } from "../src/config.js";
import { createMexcRequestLimiter, MexcClient } from "../src/mexc-client.js";
import { runLocalHarsiScan } from "../src/local-scanner.js";
import { createLocalSqliteStore } from "../src/local-sqlite-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.fetch ??= undiciFetch;
if (typeof AbortSignal.any !== "function") {
  AbortSignal.any = (signals) => {
    const controller = new AbortController();
    const abort = (signal) => controller.abort(signal.reason);
    for (const signal of signals) {
      if (signal.aborted) { abort(signal); break; }
      signal.addEventListener("abort", () => abort(signal), { once: true });
    }
    return controller.signal;
  };
}

let windowRef;
let db;
let store;
let running = false;
let controller = null;
let lastError = null;
let completedAt = null;
let lastSummary = null;
let activeJob = "idle";

function status() {
  return { status: activeJob, startedAt: null, finishedAt: completedAt, error: lastError, summary: lastSummary };
}
function publish(extra = {}) {
  windowRef?.webContents.send("harsi:status", { ...status(), ...extra });
}
async function loadSavedRows() {
  const saved = (await Promise.all(["Min1", "Min15", "Min60"].map(async (timeframe) =>
    (await store.getLatestHarsiResults(2000, timeframe)).map((row) => ({
      symbol: row.symbol, timeframe, haClose: row.ha_close == null ? null : Number(row.ha_close),
      candleOpenTime: row.open_time
    }))
  ))).flat();
  if (saved.length) {
    lastSummary = {
      eligibleContracts: saved.length, updatedContracts: saved.length, failedContracts: 0,
      completedAt: new Date().toISOString(), results: saved
    };
    completedAt = lastSummary.completedAt;
    activeJob = "completed";
  }
}
async function runScan(timeframes) {
  if (running) return status();
  running = true;
  controller = new AbortController();
  activeJob = "running";
  lastError = null;
  publish({ progress: { processed: 0, total: 0, failed: 0, results: [] } });
  try {
    const limiter = createMexcRequestLimiter();
    const progressByTimeframe = new Map();
    const outcomes = await Promise.allSettled(timeframes.map((timeframe) =>
      runLocalHarsiScan({
        mexc: new MexcClient({ signal: controller.signal, requestLimiter: limiter }),
        store, maxPrice: config.maxPrice, signal: controller.signal, timeframe,
        workerCount: timeframes.length > 1 ? 3 : 5,
        onProgress: (progress) => {
          if (controller?.signal.aborted) return;
          progressByTimeframe.set(timeframe, progress);
          const combined = [...progressByTimeframe.values()].reduce((a, p) => ({
            processed: Math.max(a.processed, p.processed), total: Math.max(a.total, p.total),
            failed: Math.max(a.failed, p.failed), updated: a.updated + p.updated,
            remaining: Math.max(a.remaining, p.remaining), results: [...a.results, ...(p.results || [])]
          }), { processed: 0, total: 0, failed: 0, updated: 0, remaining: 0, results: [] });
          publish({ progress: { ...combined, timeframes: [...progressByTimeframe.keys()] } });
        }
      })
    ));
    if (controller.signal.aborted) throw new DOMException("Scan was stopped.", "AbortError");
    const rejected = outcomes.find((item) => item.status === "rejected");
    if (rejected) throw rejected.reason;
    const summaries = outcomes.map((item) => item.value);
    lastSummary = {
      eligibleContracts: summaries.reduce((n, item) => n + item.eligibleContracts, 0),
      updatedContracts: summaries.reduce((n, item) => n + item.updatedContracts, 0),
      failedContracts: summaries.reduce((n, item) => n + item.failedContracts, 0),
      completedAt: new Date().toISOString(),
      results: summaries.flatMap((item) => item.results)
    };
    completedAt = lastSummary.completedAt;
    activeJob = "completed";
    lastError = null;
  } catch (error) {
    if (error.name === "AbortError" || controller?.signal.aborted) activeJob = "paused";
    else { activeJob = "failed"; lastError = error.message || String(error); }
  } finally {
    running = false;
    controller = null;
    publish();
  }
  return status();
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1120, height: 820, minWidth: 720, minHeight: 600,
    backgroundColor: "#0b1220",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowRef.loadFile(path.join(here, "..", "www", "index.html"));
  windowRef.on("closed", () => { windowRef = null; });
}

app.whenReady().then(async () => {
  db = new Database(path.join(app.getPath("userData"), "harsi-local.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000");
  store = createLocalSqliteStore({
    execute: async (sql) => db.exec(sql),
    run: async (sql, values = []) => db.prepare(sql).run(...values),
    query: async (sql, values = []) => { const statement = db.prepare(sql); return { values: statement.reader ? statement.all(...values) : (statement.run(...values), []) }; },
    executeSet: async (operations, transaction = true) => {
      const work = () => { for (const item of operations) db.prepare(item.statement).run(...(item.values || [])); };
      if (transaction) db.transaction(work)(); else work();
      return {};
    }
  });
  await store.initialize();
  await loadSavedRows();
  createWindow();
  ipcMain.handle("harsi:status", () => status());
  ipcMain.handle("harsi:refresh", async (_event, timeframes) => {
    const selected = [...new Set(timeframes || [])].filter((v) => ["Min1", "Min15", "Min60"].includes(v));
    if (!selected.length) throw new Error("حداقل یک تایم‌فریم را انتخاب کنید.");
    if (running) return status();
    void runScan(selected);
    return status();
  });
  ipcMain.handle("harsi:exportText", async (_event, { content, fileName }) => {
    if (typeof content !== "string" || content.length > 10_000_000) throw new Error("محتوای خروجی نامعتبر است.");
    const safeName = String(fileName || "Harsi-results.txt").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const choice = await dialog.showSaveDialog(windowRef, {
      title: "ذخیره خروجی Harsi", defaultPath: path.join(app.getPath("documents"), safeName),
      buttonLabel: "ذخیره فایل", filters: [{ name: "Text", extensions: ["txt"] }]
    });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    await writeFile(choice.filePath, content, { encoding: "utf8" });
    return { canceled: false, filePath: choice.filePath };
  });
  ipcMain.handle("harsi:cancel", () => {
    if (controller) controller.abort();
    return status();
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  console.error("Harsi desktop startup failed:", error);
  app.quit();
});
app.on("before-quit", () => { if (controller) controller.abort(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
