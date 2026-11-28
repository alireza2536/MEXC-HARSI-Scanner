import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM = "https://api.mexc.com";
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IN_FLIGHT = 40;
const RATE_PER_SECOND = 12;
const RATE_BURST = 30;
const CACHE_TTL_MS = {
  "/api/v1/contract/ping": 2_000,
  "/api/v1/contract/detail": 30_000,
  "/api/v1/contract/ticker": 3_000
};
const cache = new Map();
const clients = new Map();
let inFlight = 0;

const allowedOrigins = new Set([
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
  "http://127.0.0.1"
]);

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "Accept");
  response.setHeader("access-control-max-age", "600");
  return true;
}

function isRateAllowed(ip) {
  const now = Date.now();
  const current = clients.get(ip) || { tokens: RATE_BURST, updatedAt: now };
  current.tokens = Math.min(RATE_BURST, current.tokens + ((now - current.updatedAt) / 1000) * RATE_PER_SECOND);
  current.updatedAt = now;
  if (current.tokens < 1) {
    clients.set(ip, current);
    return false;
  }
  current.tokens -= 1;
  clients.set(ip, current);
  if (clients.size > 10_000) {
    for (const [key, value] of clients) {
      if (now - value.updatedAt > 60_000) clients.delete(key);
    }
  }
  return true;
}

function resolveUpstreamPath(url) {
  // Render/browser clients may normalize or encode the incoming path differently.
  // Canonicalize it before applying the strict endpoint allowlist.
  let path;
  try {
    path = "/" + decodeURIComponent(url.pathname).split("/").filter(Boolean).join("/");
  } catch {
    return null;
  }
  const allowedFixed = new Set([
    "/api/v1/contract/ping",
    "/api/v1/contract/detail",
    "/api/v1/contract/ticker"
  ]);
  if (allowedFixed.has(path)) return path;

  const match = path.match(/^\/api\/v1\/contract\/kline\/([A-Z0-9_]{2,40})$/);
  if (!match) return null;
  return `/api/v1/contract/kline/${match[1]}`;
}

function validateQuery(url, path) {
  const allowed = path.endsWith("/ticker")
    ? new Set(["symbol"])
    : path.includes("/kline/")
      ? new Set(["interval", "start", "end"])
      : new Set();

  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return `Unexpected query parameter: ${key}`;
    if (url.searchParams.getAll(key).length !== 1) return `Duplicate query parameter: ${key}`;
  }

  if (path.endsWith("/ticker")) {
    const symbol = url.searchParams.get("symbol");
    if (symbol !== null && !/^[A-Z0-9_]{2,40}$/.test(symbol)) return "Invalid ticker symbol";
  }

  if (path.includes("/kline/")) {
    const interval = url.searchParams.get("interval");
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    if (!["Min5", "Min15", "Min60"].includes(interval)) return "Invalid kline interval";
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "Invalid kline time range";
    if (start <= 0 || end <= start || end - start > 7 * 24 * 60 * 60) return "Kline range exceeds allowed limits";
  }

  return null;
}

function cacheKey(path, url) {
  const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return path + (query.length ? "?" + new URLSearchParams(query).toString() : "");
}

async function proxyRequest(path, url, response) {
  const ttl = CACHE_TTL_MS[path] || 0;
  const key = cacheKey(path, url);
  const cached = ttl ? cache.get(key) : null;
  if (cached && cached.expiresAt > Date.now()) {
    response.writeHead(cached.status, cached.headers);
    response.end(cached.body);
    return;
  }

  if (inFlight >= MAX_IN_FLIGHT) {
    return sendJson(response, 503, { success: false, code: "PROXY_BUSY", message: "Proxy is busy; retry shortly." });
  }

  const upstreamUrl = new URL(path, UPSTREAM);
  for (const [name, value] of url.searchParams) upstreamUrl.searchParams.set(name, value);
  inFlight += 1;
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const body = await upstream.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return sendJson(response, 502, { success: false, code: "UPSTREAM_RESPONSE_TOO_LARGE", message: "MEXC response exceeded the allowed size." });
    }
    const headers = {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    };
    if (ttl && upstream.ok) {
      cache.set(key, { status: upstream.status, headers, body, expiresAt: Date.now() + ttl });
      if (cache.size > 500) {
        for (const [cacheKeyValue, value] of cache) {
          if (value.expiresAt <= Date.now()) cache.delete(cacheKeyValue);
        }
      }
    }
    response.writeHead(upstream.status, headers);
    response.end(body);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    sendJson(response, 502, {
      success: false,
      code: timedOut ? "MEXC_TIMEOUT" : "MEXC_UNAVAILABLE",
      message: timedOut ? "MEXC upstream request timed out." : "MEXC upstream request failed."
    });
  } finally {
    inFlight -= 1;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (!applyCors(request, response)) {
    return sendJson(response, 403, { error: "Origin is not allowed." });
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { ok: true, service: "mexc-allowlisted-proxy" });
  }
  if (request.method !== "GET") {
    return sendJson(response, 405, { error: "Only GET requests are allowed." }, { allow: "GET, OPTIONS" });
  }

  const path = resolveUpstreamPath(url);
  const queryValidationError = path ? validateQuery(url, path) : "Endpoint path is not allowlisted";
  if (!path || queryValidationError) {
    return sendJson(response, 400, {
      error: "MEXC endpoint or query parameters are not allowed.",
      reason: queryValidationError,
      method: request.method,
      receivedPath: url.pathname,
      normalizedPath: path || null,
      receivedQuery: [...url.searchParams.entries()]
    });
  }

  const forwarded = request.headers["x-forwarded-for"]?.split(",")[0]?.trim();
  const ip = forwarded || request.socket.remoteAddress || "unknown";
  if (!isRateAllowed(ip)) {
    return sendJson(response, 429, { success: false, code: "PROXY_RATE_LIMIT", message: "Too many requests; retry shortly." }, { "retry-after": "1" });
  }

  await proxyRequest(path, url, response);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MEXC allowlisted proxy listening on 0.0.0.0:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
