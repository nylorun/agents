import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTelemetry,
  telemetryCommand,
  telemetryDecision,
  telemetryPath,
} from "../src/telemetry.js";

describe("telemetry", () => {
  it("is on by default; the environment or the developer's choice turns it off", () => {
    expect(telemetryDecision({}, { format: 1 }).enabled).toBe(true);
    for (const env of [
      { NYLORUN_TELEMETRY_DISABLED: "1" },
      { NYLORUN_TELEMETRY_DISABLED: "true" },
      { DO_NOT_TRACK: "1" },
      { CI: "true" },
    ])
      expect(telemetryDecision(env, { format: 1 }).enabled).toBe(false);
    for (const env of [{ NYLORUN_TELEMETRY_DISABLED: "0" }, { DO_NOT_TRACK: "false" }, { CI: "" }])
      expect(telemetryDecision(env, { format: 1 }).enabled).toBe(true);
    expect(telemetryDecision({}, { format: 1, enabled: false })).toEqual({
      enabled: false,
      reason: 'turned off with "nylorun telemetry disable"',
    });
  });

  it("nylorun telemetry disable|enable|status keeps the choice in telemetry.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-telemetry-"));
    const lines: string[] = [];
    const run = (...args: string[]) =>
      telemetryCommand(args, { nylorunRoot: root, env: {}, out: (line) => lines.push(line) });
    await run("disable");
    expect(await readTelemetry(root)).toEqual({ format: 1, enabled: false });
    expect(lines.at(-1)).toBe('Studio telemetry is off (turned off with "nylorun telemetry disable").');
    await run("enable");
    expect(JSON.parse(await readFile(telemetryPath(root), "utf8"))).toEqual({ format: 1, enabled: true });
    lines.length = 0;
    await run();
    expect(lines[0]).toBe("Studio telemetry is on (on by default).");
    await expect(run("off")).rejects.toThrow(/Usage: nylorun telemetry/);
  });

  it("an unreadable telemetry.json counts as no choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-telemetry-"));
    await writeFile(telemetryPath(root), "{not json");
    expect(await readTelemetry(root)).toEqual({ format: 1 });
  });
});
