import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runLiveScan, runAkeHistoryDiagnostic } from "./live-scanner.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const htmlPath = path.join(publicDir, "index.html");
const MIN_START_GAP_MS = 30_000;

let job = { status: "idle", startedAt: null, finishedAt: null, error: null, summary: null };
let running = false;
let lastStartedAt = 0;
let diagnosticRunning = false;
let lastDiagnosticAt = 0;

function startLiveScan(source) {
  if (running) return false;
  running = true;
  lastStartedAt = Date.now();
  job = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null, summary: null };
  console.log(JSON.stringify({ event: "live_scan_triggered", source }));

  runLiveScan()
    .then((summary) => {
      job = { ...job, status: "completed", finishedAt: new Date().toISOString(), summary };
    })
    .catch((error) => {
      console.error(JSON.stringify({ event: "live_scan_fatal", source, error: error.message }));
      job = { ...job, status: "failed", finishedAt: new Date().toISOString(), error: error.message };
    })
    .finally(() => { running = false; });
  return true;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, job);
  }

  if (request.method === "POST" && url.pathname === "/api/diagnostic/ake-history-2323") {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin) {
      try {
        if (new URL(origin).host !== host) {
          return sendJson(response, 403, { error: "درخواست نامعتبر است." });
        }
      } catch {
        return sendJson(response, 403, { error: "مبدأ درخواست نامعتبر است." });
      }
    }
    if (diagnosticRunning) return sendJson(response, 409, { error: "آزمایش در حال اجراست." });
    const wait = 30_000 - (Date.now() - lastDiagnosticAt);
    if (wait > 0) return sendJson(response, 429, { error: "لطفاً کمی صبر کنید.", retryAfterMs: wait });

    diagnosticRunning = true;
    lastDiagnosticAt = Date.now();
    try {
      const result = await runAkeHistoryDiagnostic();
      return sendJson(response, 200, result);
    } catch (error) {
      console.error(JSON.stringify({ event: "ake_harsi_history_diagnostic_failed", error: error.message }));
      return sendJson(response, 502, { error: error.message });
    } finally {
      diagnosticRunning = false;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin) {
      try {
        if (new URL(origin).host !== host) {
          return sendJson(response, 403, { error: "درخواست نامعتبر است." });
        }
      } catch {
        return sendJson(response, 403, { error: "مبدأ درخواست نامعتبر است." });
      }
    }

    if (running) return sendJson(response, 409, { error: "بروزرسانی در حال اجراست.", job });
    const wait = MIN_START_GAP_MS - (Date.now() - lastStartedAt);
    if (wait > 0) return sendJson(response, 429, { error: "لطفاً کمی صبر کنید و دوباره تلاش کنید.", retryAfterMs: wait });

    startLiveScan("manual");
    return sendJson(response, 202, { accepted: true, job });
  }

  if (request.method === "GET" && url.pathname === "/") {
    try {
      const html = await readFile(htmlPath);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      return response.end(html);
    } catch {
      return sendJson(response, 500, { error: "صفحه در دسترس نیست." });
    }
  }

  return sendJson(response, 404, { error: "یافت نشد." });
});

server.listen(PORT, HOST, () => {
  console.log(`MEXC live scanner web server listening on ${HOST}:${PORT}`);
  // Start the AKE pilot once the HTTP server is listening. This runs after
  // every process start/restart; the existing in-process candle cache is
  // initialized by the scan and remains unchanged for later refreshes.
  startLiveScan("server_startup");
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
