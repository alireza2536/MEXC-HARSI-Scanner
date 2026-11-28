import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const MEXC_PING_URL = "https://api.mexc.com/api/v1/contract/ping";
let lastProbeAt = 0;
let cachedResult = null;

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  }

  if (req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, service: "mexc-connectivity-probe" }));
  }

  if (req.url !== "/probe") {
    res.writeHead(404);
    return res.end(JSON.stringify({ ok: false, error: "not_found" }));
  }

  // Prevent repeated public requests from turning this diagnostic into a traffic relay.
  const now = Date.now();
  if (cachedResult && now - lastProbeAt < 15000) {
    res.writeHead(200);
    return res.end(JSON.stringify({ ...cachedResult, cached: true }));
  }

  lastProbeAt = now;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(MEXC_PING_URL, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "MEXC-HARSI-connectivity-check/1.0" },
      signal: controller.signal
    });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}

    cachedResult = {
      ok: response.ok && parsed?.success === true,
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      mexcSuccess: parsed?.success ?? null,
      mexcCode: parsed?.code ?? null,
      checkedAt: new Date().toISOString()
    };
    res.writeHead(200);
    res.end(JSON.stringify(cachedResult));
  } catch (error) {
    cachedResult = {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error?.name === "AbortError" ? "timeout_after_10000ms" : String(error?.cause?.code || error?.message || error),
      checkedAt: new Date().toISOString()
    };
    res.writeHead(200);
    res.end(JSON.stringify(cachedResult));
  } finally {
    clearTimeout(timeout);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "probe_server_ready", port: PORT }));
});
