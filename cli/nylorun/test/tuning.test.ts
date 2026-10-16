import { afterEach, describe, expect, it } from "vitest";
import { cliTuning, DEFAULT_CLI_TUNING } from "../src/tuning.js";
import { renderComposeFile } from "../src/stack/compose-file.js";

const saved = process.env.NYLORUN_CLI_TUNING;
afterEach(() => {
  if (saved === undefined) delete process.env.NYLORUN_CLI_TUNING;
  else process.env.NYLORUN_CLI_TUNING = saved;
});

describe("CLI tuning (NYLORUN_CLI_TUNING)", () => {
  it("defaults to the values the CLI used before", () => {
    expect(cliTuning({})).toBe(DEFAULT_CLI_TUNING);
    expect(DEFAULT_CLI_TUNING.stack).toMatchObject({ healthWaitMs: 60_000, pollMs: 500, composeWaitSeconds: 300 });
    expect(DEFAULT_CLI_TUNING.compose.healthchecks.harness).toEqual({ intervalSeconds: 2, timeoutSeconds: 5, retries: 90 });
    expect(DEFAULT_CLI_TUNING.sandbox).toMatchObject({ kubectlTimeoutMs: 300_000, probeCpu: "200m", probeMemory: "64Mi" });
  });

  it("keeps the defaults of what a partial setting leaves out", () => {
    const tuning = cliTuning({ NYLORUN_CLI_TUNING: JSON.stringify({ stack: { pollMs: 50 } }) });
    expect(tuning.stack.pollMs).toBe(50);
    expect(tuning.stack.healthWaitMs).toBe(60_000);
    expect(tuning.compose).toEqual(DEFAULT_CLI_TUNING.compose);
  });

  it("refuses an unknown key, a bad value and bad JSON, naming the path", () => {
    expect(() => cliTuning({ NYLORUN_CLI_TUNING: JSON.stringify({ stack: { nope: 1 } }) })).toThrow(/stack\.nope is not a setting/);
    expect(() => cliTuning({ NYLORUN_CLI_TUNING: JSON.stringify({ stack: { pollMs: 0 } }) })).toThrow(/stack\.pollMs must be a whole number/);
    expect(() => cliTuning({ NYLORUN_CLI_TUNING: JSON.stringify({ sandbox: { probeCpu: "" } }) })).toThrow(/sandbox\.probeCpu/);
    expect(() => cliTuning({ NYLORUN_CLI_TUNING: "{" })).toThrow(/must be a JSON object/);
  });

  it("a set healthcheck and WAL cap reach the Compose file", () => {
    process.env.NYLORUN_CLI_TUNING = JSON.stringify({
      compose: { walKeepSizeMb: 512, healthchecks: { postgres: { retries: 7 } } },
    });
    const compose = renderComposeFile("nylorun-shop", "shop");
    expect(compose).toContain("max_slot_wal_keep_size=512MB");
    expect(compose).toMatch(/pg_isready[^\n]*\n\s+interval: 2s\n\s+timeout: 5s\n\s+retries: 7\n/);
  });
});
