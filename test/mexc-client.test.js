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
