import { config } from "./config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Base-asset codes for fiat-pegged and other stable-value tokens.
// This is deliberately separate from the price filter: it only excludes
// stablecoins and does not impose any additional market/volume criteria.
export const STABLECOIN_BASE_ASSETS = new Set([
  "USDT", "USDC", "BUSD", "TUSD", "FDUSD", "USDP", "DAI", "USDS",
  "USDE", "USDD", "PYUSD", "GUSD", "FRAX", "LUSD", "CRVUSD", "SUSD",
  "USTC", "UST", "EUR", "EURT", "EURC", "AEUR", "EURI", "EUROC",
  "USD1", "RLUSD", "USD0", "USDQ", "USDX", "USDK"
]);

export function isStablecoinBaseAsset(baseCoin) {
  return STABLECOIN_BASE_ASSETS.has(String(baseCoin || "").trim().toUpperCase());
}

export class MexcClient {
  #lastRequestAt = 0;

  async #get(path, params = {}) {
    const wait = Math.max(0, config.requestSpacingMs - (Date.now() - this.#lastRequestAt));
    if (wait) await sleep(wait);

    const url = new URL(`${config.mexcBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.#lastRequestAt = Date.now();
      response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(`MEXC HTTP ${response.status} for ${path}`);
      }
      await sleep(500 * (2 ** attempt));
    }

    const body = await response.json();
    if (body?.success === false || (body?.code !== undefined && Number(body.code) !== 0)) {
      throw new Error(`MEXC API error for ${path}: ${body.message || body.code || "unknown"}`);
    }
    return body?.data;
  }

  async getServerTimeMs() {
    const data = await this.#get("/api/v1/contract/ping");
    const value = Number(data);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid MEXC server time response.");
    return value;
  }

  async getEligibleUsdtContracts(maxPrice) {
    const [contractsData, tickerData] = await Promise.all([
      this.#get("/api/v1/contract/detail"),
      this.#get("/api/v1/contract/ticker")
    ]);

    const contracts = Array.isArray(contractsData) ? contractsData : [];
    let tickers = Array.isArray(tickerData) ? tickerData : [];

    // Some API responses return a single ticker object instead of the full ticker list.
    // In that case, query the remaining contracts individually so no symbols are silently skipped.
    if (!Array.isArray(tickerData) && contracts.length > 1) {
      const first = tickerData?.symbol ? [tickerData] : [];
      const firstSymbols = new Set(first.map((item) => item.symbol));
      tickers = [...first];
      for (const contract of contracts) {
        if (firstSymbols.has(contract.symbol)) continue;
        try {
          const ticker = await this.#get("/api/v1/contract/ticker", { symbol: contract.symbol });
          if (ticker && !Array.isArray(ticker)) tickers.push(ticker);
          else if (Array.isArray(ticker)) tickers.push(...ticker);
        } catch (error) {
          // Missing ticker for one contract should not stop collection for all other contracts.
          console.warn(JSON.stringify({ event: "ticker_fetch_failed", symbol: contract.symbol, error: error.message }));
        }
      }
    } else if (!Array.isArray(tickerData) && tickerData) {
      tickers = [tickerData];
    }

    const tickerBySymbol = new Map(tickers.map((item) => [item.symbol, item]));

    return contracts
      .filter((contract) => {
        const isUsdt = contract.quoteCoin === "USDT" && contract.settleCoin === "USDT";
        const isEnabled = Number(contract.state) === 0;
        const baseCoin = contract.baseCoin || String(contract.symbol || "").replace(/USDT$/i, "");
        const isNotStablecoin = !isStablecoinBaseAsset(baseCoin);
        return isUsdt && isEnabled && isNotStablecoin && tickerBySymbol.has(contract.symbol);
      })
      .map((contract) => {
        const ticker = tickerBySymbol.get(contract.symbol);
        return { symbol: contract.symbol, lastPrice: Number(ticker.lastPrice) };
      })
      .filter((item) => Number.isFinite(item.lastPrice) && item.lastPrice > 0 && item.lastPrice < maxPrice);
  }

  async get15mCandles(symbol, startSeconds, endSeconds) {
    const data = await this.#get(
      `/api/v1/contract/kline/${encodeURIComponent(symbol)}`,
      { interval: "Min15", start: startSeconds, end: endSeconds }
    );

    if (!data || !Array.isArray(data.time)) {
      throw new Error(`Invalid candle response for ${symbol}`);
    }

    const fields = ["open", "high", "low", "close", "vol", "amount"];
    for (const field of fields) {
      if (!Array.isArray(data[field]) || data[field].length !== data.time.length) {
        throw new Error(`Malformed ${field} candle array for ${symbol}`);
      }
    }

    return data.time.map((time, index) => {
      const values = {
        open_price: Number(data.open[index]),
        high_price: Number(data.high[index]),
        low_price: Number(data.low[index]),
        close_price: Number(data.close[index]),
        volume: Number(data.vol[index]),
        amount: Number(data.amount[index])
      };
      if (!Number.isFinite(Number(time)) || !Object.values(values).every(Number.isFinite)) {
        throw new Error(`Non-numeric candle values received for ${symbol} at index ${index}`);
      }
      return {
        symbol,
        open_time: new Date(Number(time) * 1000).toISOString(),
        close_time: new Date((Number(time) + 900) * 1000).toISOString(),
        ...values
      };
    });
  }
}
