import { describe, expect, it } from "vitest";
import { doctorStack } from "../src/doctor.js";
import { fakeDocker, temporaryHome, testDeps } from "./stack/support.js";

describe("doctor (the stack)", () => {
  it("reports Node, Docker, Compose and an absent stack; exit 0", async () => {
    const lines: string[] = [];
    const deps = testDeps(await temporaryHome());
    const code = await doctorStack({ json: false, deps, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/node\s+✓/);
    expect(text).toMatch(/docker\s+✓ 29\.0\.0/);
    expect(text).toMatch(/compose\s+✓ 2\.40\.0/);
    expect(text).toMatch(/stack\s+- home-root not created .*nylorun up/);
  });

  it("says when no stack is selected here, and still exits 0", async () => {
    const lines: string[] = [];
    const deps = testDeps(await temporaryHome(), { env: {} });
    expect(await doctorStack({ json: false, deps, log: (line) => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toMatch(/stack\s+- No stack selected/);
  });

  it("names the fix when Docker is missing and skips the stack; exit 1", async () => {
    const lines: string[] = [];
    const docker = fakeDocker({
      respond: (args) =>
        args[0] === "version" ? { code: 127, stdout: "", stderr: "", missing: true } : undefined,
    });
    const deps = testDeps(await temporaryHome(), { docker });
    const code = await doctorStack({ json: true, deps, log: (line) => lines.push(line) });
    expect(code).toBe(1);
    const report = JSON.parse(lines.join("\n")) as {
      docker: { ok: boolean; problem?: string };
      compose?: unknown;
      stack?: unknown;
    };
    expect(report.docker.ok).toBe(false);
    expect(report.docker.problem).toMatch(/Docker Desktop, OrbStack, Colima/);
    expect(report.compose).toBeUndefined();
    expect(report.stack).toBeUndefined();
  });

  it("fails on Compose v1", async () => {
    const lines: string[] = [];
    const docker = fakeDocker({
      respond: (args) =>
        args[0] === "compose" && args[1] === "version"
          ? { code: 0, stdout: "1.29.2\n", stderr: "" }
          : undefined,
    });
    const deps = testDeps(await temporaryHome(), { docker });
    expect(await doctorStack({ json: false, deps, log: (line) => lines.push(line) })).toBe(1);
    expect(lines.join("\n")).toMatch(/compose\s+✗ Docker Compose v2 is required/);
  });
});
