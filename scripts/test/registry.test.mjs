import assert from "node:assert/strict";
import { test } from "node:test";
import { registry } from "../release/registry.mjs";

test("publication waits through npm processing lasting longer than twenty seconds", async () => {
  let lookups = 0;
  let elapsed = 0;
  const published = { integrity: "sha512-reviewed-artifact" };
  const result = await registry.waitFor.call({
    lookup: async () => ++lookups < 16 ? undefined : published,
  }, "runtime", "0.1.1-beta", { sleep: async (ms) => { elapsed += ms; } });
  assert.deepEqual(result, published);
  assert.equal(lookups, 16);
  assert.equal(elapsed, 75000);
});

test("publication visibility polling remains bounded when npm never exposes a version", async () => {
  let lookups = 0;
  let elapsed = 0;
  await assert.rejects(registry.waitFor.call({
    lookup: async () => { lookups++; return undefined; },
  }, "runtime", "0.1.1-beta", { sleep: async (ms) => { elapsed += ms; } }),
  /Registry has not exposed runtime@0.1.1-beta/);
  assert.equal(lookups, 120);
  assert.equal(elapsed, 600000);
});

test("the public smoke waits until npm install sees each published version", async () => {
  let checks = 0;
  let packs = 0;
  let elapsed = 0;
  await registry.waitForInstall.call({
    installable: async () => ++checks >= 13,
    fetchable: async () => ++packs >= 1,
  }, "create-agent", "0.10.0-beta", { sleep: async (ms) => { elapsed += ms; } });
  assert.equal(checks, 13);
  assert.equal(packs, 1);
  assert.equal(elapsed, 60000);
});

test("waiting for npm install also requires a clean-cache npm pack to succeed", async () => {
  let packs = 0;
  let elapsed = 0;
  await registry.waitForInstall.call({
    installable: async () => true,
    fetchable: async () => ++packs >= 4,
  }, "create-agent", "0.10.2-beta", { sleep: async (ms) => { elapsed += ms; } });
  assert.equal(packs, 4);
  assert.equal(elapsed, 15000);
});

test("waiting for npm install remains bounded when the CDN never serves a version", async () => {
  let checks = 0;
  let packs = 0;
  await assert.rejects(registry.waitForInstall.call({
    installable: async () => { checks++; return false; },
    fetchable: async () => { packs++; return true; },
  }, "create-agent", "0.10.0-beta", { sleep: async () => {} }),
  /npm install does not see create-agent@0.10.0-beta yet/);
  assert.equal(checks, 120);
  assert.equal(packs, 0);
});
