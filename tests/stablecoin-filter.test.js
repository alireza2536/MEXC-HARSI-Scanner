import test from "node:test";
import assert from "node:assert/strict";
import {
  isStablecoinBaseAsset,
  isTraditionalMarketBaseAsset,
  isEligibleCryptoBaseAsset,
  isStockInstrument
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
