/**
 * The pod engine's disk setup (R2d step 2, `harness/setup.ts`): input files then commands, once
 * per volume (the marker), a failure reported and the setup run again when core says so.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localExec } from "../../src/adapters/sandbox/local.js";
import type { DiskSetup, DiskSetupReport } from "../../src/harness/pod.js";
import { prepareDisk } from "../../src/harness/setup.js";

let root: string;
const logger = { info: () => undefined, warn: () => undefined };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-disk-setup-"));
  await writeFile(join(root, "volume-id"), "vol-1\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A host that serves one file and one folder, and keeps every report. */
function host(setup: DiskSetup, retries: (DiskSetup | undefined)[] = []) {
  const reports: DiskSetupReport[] = [];
  const files = new Map<string, Response>();
  return {
    reports,
    setup,
    async setupState() {
      const next = retries.shift();
      return next === undefined ? { retry: false } : { retry: true, setup: next };
    },
    async reportSetup(report: DiskSetupReport) {
      reports.push(report);
    },
    async setupFile(index: number, path?: string) {
      void files;
      if (index === 0 && path === undefined)
        return new Response("seed\n", { headers: { "x-nylorun-artifact-kind": "file" } });
      if (index === 1 && path === undefined)
        return Response.json(
          { entries: [{ path: "a.txt", size: 2 }, { path: "deep/b.txt", size: 2 }] },
          { headers: { "x-nylorun-artifact-kind": "folder" } },
        );
      if (index === 1 && path === "a.txt") return new Response("a\n");
      if (index === 1 && path === "deep/b.txt") return new Response("b\n");
      return new Response("", { status: 404 });
    },
  };
}

const exec = localExec({ env: { PATH: process.env.PATH }, workspace: "/tmp" });

describe("prepareDisk", () => {
  it("copies the files, runs the commands with the variables, and skips a volume it already set up", async () => {
    const work = join(root, "workspace");
    const setup: DiskSetup = {
      recipeVersion: 2,
      files: [
        { index: 0, path: join(work, "seed.txt") },
        { index: 1, path: join(work, "tree") },
      ],
      commands: [
        { command: 'cat seed.txt tree/a.txt tree/deep/b.txt > all.txt; echo "$REGION" > region.txt', cwd: work, timeoutMs: 10_000 },
      ],
      environment: { REGION: "eu-west-1" },
    };
    const fake = host(setup);
    const options = { host: fake, exec, volumeFile: join(root, "volume-id"), markerFile: join(root, "setup.json"), logger };
    await prepareDisk(options);
    expect(await readFile(join(work, "all.txt"), "utf8")).toBe("seed\na\nb\n");
    expect(await readFile(join(work, "region.txt"), "utf8")).toBe("eu-west-1\n");
    expect(JSON.parse(await readFile(join(root, "setup.json"), "utf8"))).toEqual({
      volumeId: "vol-1",
      recipeVersion: 2,
      status: "ok",
    });
    expect(fake.reports).toEqual([{ status: "ok" }]);

    // The same volume: nothing runs again.
    await rm(join(work, "all.txt"));
    await prepareDisk(options);
    await expect(readFile(join(work, "all.txt"), "utf8")).rejects.toThrow();
    expect(fake.reports).toHaveLength(1);

    // A new volume (a reset): it runs again.
    await writeFile(join(root, "volume-id"), "vol-2\n");
    await prepareDisk(options);
    expect(await readFile(join(work, "all.txt"), "utf8")).toBe("seed\na\nb\n");
  });

  it("reports a failed command with its exit code and output, then runs the setup core hands back", async () => {
    const work = join(root, "workspace");
    const failing: DiskSetup = {
      recipeVersion: 1,
      files: [],
      commands: [{ command: "echo partial; exit 3", cwd: work, timeoutMs: 10_000 }],
      environment: {},
    };
    const fixed: DiskSetup = { ...failing, recipeVersion: 2, commands: [{ command: "echo fixed > ok.txt", cwd: work, timeoutMs: 10_000 }] };
    const fake = host(failing, [undefined, fixed]);
    await prepareDisk({
      host: fake,
      exec,
      volumeFile: join(root, "volume-id"),
      markerFile: join(root, "setup.json"),
      logger,
      pollMs: 10,
    });
    expect(fake.reports[0]).toMatchObject({ status: "failed", index: 0, exitCode: 3 });
    expect(fake.reports[0]!.output).toContain("partial");
    expect(fake.reports[1]).toEqual({ status: "ok" });
    expect(await readFile(join(work, "ok.txt"), "utf8")).toBe("fixed\n");
    expect(JSON.parse(await readFile(join(root, "setup.json"), "utf8")).recipeVersion).toBe(2);
  });

  it("refuses a folder entry that would leave its path", async () => {
    const work = join(root, "workspace");
    const fake = {
      ...host({ recipeVersion: 1, files: [{ index: 1, path: join(work, "tree") }], commands: [], environment: {} }),
      async setupFile(_index: number, path?: string) {
        return path === undefined
          ? Response.json({ entries: [{ path: "../../escape.txt", size: 1 }] }, { headers: { "x-nylorun-artifact-kind": "folder" } })
          : new Response("x");
      },
    };
    const controller = new AbortController();
    const done = prepareDisk({
      host: fake,
      exec,
      volumeFile: join(root, "volume-id"),
      markerFile: join(root, "setup.json"),
      logger,
      pollMs: 10,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await done;
    expect(fake.reports[0]).toMatchObject({ status: "failed" });
    expect(fake.reports[0]!.output).toMatch(/would leave/);
    await expect(readFile(join(root, "escape.txt"), "utf8")).rejects.toThrow();
  });
});
