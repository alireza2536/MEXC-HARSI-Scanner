import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const MEXC_BASE = "https://api.mexc.com";
const ENDPOINTS = {
  ping: "/api/v1/contract/ping",
  contractDetail: "/api/v1/contract/detail",
  ticker: "/api/v1/contract/ticker"
};
let pingCache = null;
let pingCacheAt = 0;

async function checkEndpoint(path, timeoutMs = 15000) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(MEXC_BASE + path, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "MEXC-HARSI-connectivity-check/1.0" },
      signal: controller.signal
    });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    return {
      ok: response.ok && parsed?.success === true,
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      mexcSuccess: parsed?.success ?? null,
      mexcCode: parsed?.code ?? null,
      dataCount: Array.isArray(parsed?.data) ? parsed.data.length : null,
      dataKeys: parsed?.data && !Array.isArray(parsed.data) && typeof parsed.data === "object" ? Object.keys(parsed.data).slice(0, 8) : undefined
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error?.name === "AbortError" ? `timeout_after_${timeoutMs}ms` : String(error?.cause?.code || error?.message || error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  }
  const pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/" || pathname === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, service: "mexc-connectivity-probe", endpoints: ["/health", "/probe", "/probe-market"] }));
  }
  if (pathname === "/probe") {
    const now = Date.now();
    if (pingCache && now - pingCacheAt < 15000) {
      res.writeHead(200);
      return res.end(JSON.stringify({ ...pingCache, cached: true }));
    }
    pingCache = await checkEndpoint(ENDPOINTS.ping, 10000);
    pingCacheAt = Date.now();
    res.writeHead(200);
    return res.end(JSON.stringify({ ...pingCache, checkedAt: new Date().toISOString() }));
  }
  if (pathname === "/probe-market") {
    const [contractDetail, ticker] = await Promise.all([
      checkEndpoint(ENDPOINTS.contractDetail),
      checkEndpoint(ENDPOINTS.ticker)
    ]);
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: contractDetail.ok && ticker.ok,
      checkedAt: new Date().toISOString(),
      contractDetail,
      ticker
    }));
  }
  res.writeHead(404);
  return res.end(JSON.stringify({ ok: false, error: "not_found", receivedPath: pathname }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "probe_server_ready", port: PORT }));
});
