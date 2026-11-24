import { config } from "./config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Base-asset codes for fiat-pegged and other stable-value tokens.
export const STABLECOIN_BASE_ASSETS = new Set([
  "USDT", "USDC", "BUSD", "TUSD", "FDUSD", "USDP", "DAI", "USDS",
  "USDE", "USDD", "PYUSD", "GUSD", "FRAX", "LUSD", "CRVUSD", "SUSD",
  "USTC", "UST", "EUR", "EURT", "EURC", "AEUR", "EURI", "EUROC",
  "USD1", "RLUSD", "USD0", "USDQ", "USDX", "USDK"
]);

export function isStablecoinBaseAsset(baseCoin) {
  return STABLECOIN_BASE_ASSETS.has(String(baseCoin || "").trim().toUpperCase());
}

// Traditional-market instruments, fiat currencies, and gold-backed tokens are excluded.
export const TRADITIONAL_MARKET_BASE_ASSETS = new Set([
  "XAU", "XAG", "GOLD", "SILVER", "PLATINUM", "PALLADIUM",
  "OIL", "WTI", "BRENT", "USOIL", "UKOIL", "CRUDEOIL",
  "NG", "NGAS", "NATGAS", "GAS", "NATURALGAS", "COPPER", "PAXG", "XAUT",
  "DXY", "SPX", "SP500", "US500", "NAS100", "US100", "NASDAQ",
  "US30", "DJ30", "DOW", "GER40", "DE40", "DAX", "UK100",
  "FTSE", "JP225", "NIKKEI", "HK50", "HSI", "FRA40", "CAC40",
  "AUS200", "ASX200", "VIX",
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD",
  "CNY", "CNH", "HKD", "SGD", "INR", "KRW", "TRY", "RUB",
  "BRL", "MXN", "ZAR", "AED", "SAR", "PLN", "SEK", "NOK",
  "DKK", "THB", "IDR", "PHP", "VND"
]);

export function isTraditionalMarketBaseAsset(baseCoin) {
  return TRADITIONAL_MARKET_BASE_ASSETS.has(String(baseCoin || "").trim().toUpperCase());
}

export function isStockInstrument(value) {
  return String(value || "").trim().toUpperCase().includes("STOCK");
}

// MEXC contract detail does not expose a universal asset-class field.
// Use all descriptive metadata it does provide to reject explicitly tagged
// equities, ETFs, indices, FX, and commodity instruments. Do not infer that
// an arbitrary ticker-shaped baseCoin is a stock: many crypto assets use that form.
const NON_CRYPTO_METADATA_PATTERN =
  /(?:^|[^A-Z0-9])(?:STOCKS?|EQUIT(?:Y|IES)|SHARES?|ETF|ETFS|INDEX|INDICES|INDUSTRIALS?|COMMODIT(?:Y|IES)|PRECIOUS\s+METALS?|FOREX|FX\s+PAIR|CURRENCY\s+PAIR|ENERGY\s+MARKET)(?:$|[^A-Z0-9])/i;

export function isNonCryptoInstrument(contract = {}) {
  const baseCoin = contract.baseCoin || String(contract.symbol || "").replace(/[_-]?USDT$/i, "");
  if (!isEligibleCryptoBaseAsset(baseCoin) || isStockInstrument(contract.symbol)) return true;

  const metadata = [
    contract.displayName,
    contract.displayNameEn,
    contract.baseCoinName,
    contract.conceptPlate,
    contract.conceptPlateName,
    contract.category,
    contract.assetType,
    contract.instrumentType
  ].flat(Infinity).filter(Boolean).join(" ");

  return NON_CRYPTO_METADATA_PATTERN.test(metadata)
    || /(?:^|[^A-Z0-9])(?:SPX|SP500|US500|NAS100|US100|NASDAQ|US30|DJ30|DAX|GER40|DE40|UK100|FTSE|JP225|NIKKEI|HK50|HSI|VIX)(?:$|[^A-Z0-9])/i.test(
      [contract.symbol, baseCoin].filter(Boolean).join(" ")
    );
}

export function isEligibleCryptoBaseAsset(baseCoin) {
  return !isStablecoinBaseAsset(baseCoin)
    && !isTraditionalMarketBaseAsset(baseCoin)
    && !isStockInstrument(baseCoin);
}

export class MexcClient {
  #nextRequestAt = 0;

  async #waitForRequestSlot() {
    // Reserve each start time synchronously so concurrent workers still
    // respect the configured minimum spacing between MEXC requests.
    const scheduledAt = Math.max(Date.now(), this.#nextRequestAt);
    this.#nextRequestAt = scheduledAt + Math.max(0, config.requestSpacingMs);
    const wait = scheduledAt - Date.now();
    if (wait > 0) await sleep(wait);
  }

  async #get(path, params = {}) {
    const url = new URL(`${config.mexcBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.#waitForRequestSlot();
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
        return isUsdt && isEnabled && !isNonCryptoInstrument(contract) && tickerBySymbol.has(contract.symbol);
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
