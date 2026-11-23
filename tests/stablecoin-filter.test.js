import test from "node:test";
import assert from "node:assert/strict";
import {
  isStablecoinBaseAsset,
  isTraditionalMarketBaseAsset,
  isEligibleCryptoBaseAsset,
  isStockInstrument,
  isNonCryptoInstrument
} from "../src/mexc-client.js";

test("identifies common USD and EUR stablecoin base assets", () => {
  for (const asset of ["USDT", "USDC", "FDUSD", "DAI", "USDE", "PYUSD", "EURC"]) {
    assert.equal(isStablecoinBaseAsset(asset), true, asset);
  }
});

test("does not classify ordinary crypto assets as stablecoins", () => {
  for (const asset of ["BTC", "ETH", "SOL", "XRP", "DOGE", "MEXC"]) {
    assert.equal(isStablecoinBaseAsset(asset), false, asset);
  }
});

test("normalizes stablecoin codes and rejects empty values", () => {
  assert.equal(isStablecoinBaseAsset(" usdc "), true);
  assert.equal(isStablecoinBaseAsset(""), false);
  assert.equal(isStablecoinBaseAsset(null), false);
});

test("excludes traditional market instruments and fiat currencies", () => {
  for (const asset of ["XAU", "XAG", "OIL", "WTI", "BRENT", "NATGAS", "DXY", "SPX", "NAS100", "EUR", "GBP", "JPY"]) {
    assert.equal(isTraditionalMarketBaseAsset(asset), true, asset);
    assert.equal(isEligibleCryptoBaseAsset(asset), false, asset);
  }
});

test("excludes gold-backed tokens", () => {
  for (const asset of ["PAXG", "XAUT"]) {
    assert.equal(isTraditionalMarketBaseAsset(asset), true, asset);
    assert.equal(isEligibleCryptoBaseAsset(asset), false, asset);
  }
});

test("excludes stock-linked instruments identified by STOCK in the base asset or symbol", () => {
  for (const asset of ["AAPLSTOCK", "TSLASTOCK", "STOCK"]) {
    assert.equal(isStockInstrument(asset), true, asset);
    assert.equal(isEligibleCryptoBaseAsset(asset), false, asset);
  }
  assert.equal(isStockInstrument("BTC"), false);
  assert.equal(isStockInstrument(""), false);
});

test("excludes equity and ETF contracts using MEXC descriptive metadata", () => {
  for (const contract of [
    { symbol: "AAPL_USDT", baseCoin: "AAPL", displayNameEn: "Apple Inc. Stock Perpetual" },
    { symbol: "TSLA_USDT", baseCoin: "TSLA", conceptPlate: ["mc-trade-zone-equity"] },
    { symbol: "QQQ_USDT", baseCoin: "QQQ", displayName: "Nasdaq 100 ETF" },
    { symbol: "XYZ_USDT", baseCoin: "XYZ", assetType: "EQUITY" },
    { symbol: "SPX_USDT", baseCoin: "SPX" }
  ]) {
    assert.equal(isNonCryptoInstrument(contract), true, contract.symbol);
  }
});

test("excludes commodity and FX instruments from descriptive metadata", () => {
  assert.equal(isNonCryptoInstrument({ symbol: "GOLD_USDT", baseCoin: "GOLD" }), true);
  assert.equal(isNonCryptoInstrument({ symbol: "OIL_USDT", baseCoin: "OIL" }), true);
  assert.equal(isNonCryptoInstrument({ symbol: "EURUSD_USDT", baseCoin: "EURUSD", displayNameEn: "EUR/USD FX Pair" }), true);
});

test("keeps ordinary crypto contracts even when ticker-shaped", () => {
  for (const contract of [
    { symbol: "BTC_USDT", baseCoin: "BTC", displayNameEn: "BTC_USDT PERPETUAL", conceptPlate: ["mc-trade-zone-pow"] },
    { symbol: "SOL_USDT", baseCoin: "SOL", displayNameEn: "Solana Perpetual", conceptPlate: ["mc-trade-zone-layer1"] },
    { symbol: "XYZ_USDT", baseCoin: "XYZ", displayNameEn: "XYZ_USDT PERPETUAL", conceptPlate: ["mc-trade-zone-pow"] }
  ]) {
    assert.equal(isNonCryptoInstrument(contract), false, contract.symbol);
  }
});
