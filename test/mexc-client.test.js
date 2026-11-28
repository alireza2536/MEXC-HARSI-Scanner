import test from "node:test";
import assert from "node:assert/strict";
import { MexcClient } from "../src/mexc-client.js";

test("concurrent MEXC requests reserve spaced start times", async () => {
  const originalFetch = globalThis.fetch;
  const starts = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    return {
      ok: true,
      json: async () => ({ success: true, data: Date.now() })
    };
  };

  try {
    const client = new MexcClient();
    await Promise.all([
      client.getServerTimeMs(),
      client.getServerTimeMs(),
      client.getServerTimeMs(),
      client.getServerTimeMs()
    ]);

    assert.equal(starts.length, 4);
    for (let index = 1; index < starts.length; index += 1) {
      assert.ok(
        starts[index] - starts[index - 1] >= 110,
        `request ${index + 1} started only ${starts[index] - starts[index - 1]}ms after the prior request`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("separate timeframe clients share one aggregate MEXC request limiter", async () => {
  const originalFetch = globalThis.fetch;
  const starts = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    return {
      ok: true,
      json: async () => ({ success: true, data: Date.now() })
    };
  };

  try {
    const { createMexcRequestLimiter } = await import("../src/mexc-client.js");
    const requestLimiter = createMexcRequestLimiter();
    const oneMinuteClient = new MexcClient({ requestLimiter });
    const fifteenMinuteClient = new MexcClient({ requestLimiter });
    await Promise.all([
      oneMinuteClient.getServerTimeMs(),
      fifteenMinuteClient.getServerTimeMs(),
      oneMinuteClient.getServerTimeMs(),
      fifteenMinuteClient.getServerTimeMs()
    ]);

    assert.equal(starts.length, 4);
    for (let index = 1; index < starts.length; index += 1) {
      assert.ok(
        starts[index] - starts[index - 1] >= 110,
        `shared request ${index + 1} started only ${starts[index] - starts[index - 1]}ms after the prior request`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("MEXC client accepts Min60 and converts hourly candle close times", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("interval"), "Min60");
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          time: [1_800_000_000],
          open: [100], high: [101], low: [99], close: [100.5],
          vol: [10], amount: [1000]
        }
      })
    };
  };
  try {
    const client = new MexcClient();
    const candles = await client.getCandles("TEST_USDT", "Min60", 1_800_000_000, 1_800_003_600);
    assert.equal(candles.length, 1);
    assert.equal(Date.parse(candles[0].close_time) - Date.parse(candles[0].open_time), 3_600_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("MEXC client accepts Min5 and converts five-minute candle close times", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("interval"), "Min5");
    return new Response(JSON.stringify({ success: true, data: {
      time: [1_800_000_000], open: [1], high: [2], low: [0.5], close: [1.5], vol: [10], amount: [15]
    }}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new MexcClient();
    const candles = await client.getCandles("TEST_USDT", "Min5", 1_800_000_000, 1_800_000_300);
    assert.equal(candles[0].close_time, new Date(1_800_000_300_000).toISOString());
  } finally { globalThis.fetch = originalFetch; }
});


test("server-time ping uses the device clock after a single 8-second timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const deviceNow = 1_800_000_000_000;
  Date.now = () => deviceNow;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal.reason?.name, "TimeoutError");
    throw options.signal.reason;
  };
  try {
    const client = new MexcClient();
    assert.equal(await client.getServerTimeMs(), deviceNow);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("server-time ping still reports non-timeout errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network unavailable"); };
  try {
    const client = new MexcClient();
    await assert.rejects(client.getServerTimeMs(), /Network unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
