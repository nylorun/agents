/**
 * The disk's setup in a pod Environment's engine (R2d step 2): after it joins and before it takes
 * any turn, the engine copies the recipe's input files and runs its setup commands, once per
 * volume. A marker on the volume (`/harness/setup.json`, `{ volumeId, recipeVersion, status }`)
 * says it was done: a resume finds it and skips, a reset (a new volume, a new volume id) runs it
 * again. Commands run as the sandbox tools' do (`localExec`): `/bin/sh -c` in `cwd`, with the
 * Environment's variables and secrets (as the sentinel) and egress through egress-gate.
 *
 * A failure is reported to core, which fails the pod and the turn waiting for it; the engine then
 * polls until a turn start asks the pod to run again, and runs the setup again from the start.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, posix } from "node:path";
import type { ExecRequest, ExecResult } from "../sandbox/types.js";
import type { DiskSetup, DiskSetupReport, PodHost } from "./pod.js";

/** How often a failed setup asks whether to run again. */
export const SETUP_RETRY_POLL_MS = 5_000;
/** The end of a failed command's output kept in its report. */
const REPORT_TAIL = 4 * 1024;

export interface DiskSetupOptions {
  readonly host: Pick<PodHost, "setup" | "setupState" | "reportSetup" | "setupFile"> & {
    /** The volume starts from a disk version (R2d step 3): it holds what setup made. */
    readonly seeded?: boolean;
  };
  /** Runs one command as the sandbox tools do (`localExec`). */
  readonly exec: (request: ExecRequest, signal: AbortSignal) => Promise<ExecResult>;
  /** The volume's id file (`/harness/volume-id`). */
  readonly volumeFile: string;
  /** The marker (`/harness/setup.json`). */
  readonly markerFile: string;
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

interface Marker {
  readonly volumeId: string;
  readonly recipeVersion: number;
  readonly status: "ok";
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/** Writes `bytes` at `path`, by way of a temporary name, creating its directory. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const next = `${path}.${randomUUID()}.tmp`;
  await writeFile(next, bytes);
  await rename(next, path);
}

/** A folder entry's path joined under `base`, refused when it would leave it. */
function under(base: string, relative: string): string {
  const joined = posix.normalize(posix.join(base, relative));
  if (joined !== base && !joined.startsWith(`${base.replace(/\/$/, "")}/`))
    throw new Error(`${relative} would leave ${base}`);
  return joined;
}

/** Copies input file `file` into place: a file artifact at its path, a folder under it. */
async function copyFile(host: DiskSetupOptions["host"], file: DiskSetup["files"][number]): Promise<void> {
  const first = await host.setupFile(file.index);
  if (!first.ok) throw new Error(`input file ${file.index + 1} answered ${first.status}`);
  if (first.headers.get("x-nylorun-artifact-kind") !== "folder") {
    await writeAtomic(file.path, new Uint8Array(await first.arrayBuffer()));
    return;
  }
  const { entries } = (await first.json()) as { entries: { path: string; size: number }[] };
  for (const entry of entries) {
    const answer = await host.setupFile(file.index, entry.path);
    if (!answer.ok) throw new Error(`input file ${file.index + 1}, ${entry.path}, answered ${answer.status}`);
    await writeAtomic(under(file.path, entry.path), new Uint8Array(await answer.arrayBuffer()));
  }
}

/** Runs `setup` once: files first, then commands in order; the report of how it ended. */
async function runOnce(options: DiskSetupOptions, setup: DiskSetup): Promise<DiskSetupReport> {
  for (const file of setup.files) {
    try {
      await copyFile(options.host, file);
    } catch (error) {
      return { status: "failed", output: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const [index, command] of setup.commands.entries()) {
    options.logger.info("environment_setup_command", { index, cwd: command.cwd });
    await mkdir(command.cwd, { recursive: true }).catch(() => undefined);
    let result: ExecResult;
    try {
      result = await options.exec(
        { command: command.command, cwd: command.cwd, timeoutMs: command.timeoutMs, env: setup.environment },
        options.signal ?? new AbortController().signal,
      );
    } catch (error) {
      return { status: "failed", index, output: error instanceof Error ? error.message : String(error) };
    }
    if (result.exitCode !== 0) {
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}${result.timedOut ? "\n[timed out]" : ""}`;
      return { status: "failed", index, exitCode: result.exitCode, output: output.slice(-REPORT_TAIL) };
    }
  }
  return { status: "ok" };
}

/**
 * Runs the disk's setup when this volume has not had it, reports how it ended, and after a
 * failure waits for core to ask for it again. Resolves once the setup is done (or there is none).
 */
export async function prepareDisk(options: DiskSetupOptions): Promise<void> {
  let setup = options.host.setup;
  const volumeId = await readText(options.volumeFile);
  if (options.host.seeded) {
    // A volume seeded from a disk version: the version holds what setup made, so mark it done.
    if (volumeId) {
      const done: Marker = { volumeId, recipeVersion: setup?.recipeVersion ?? 0, status: "ok" };
      await writeAtomic(options.markerFile, new TextEncoder().encode(`${JSON.stringify(done)}\n`));
    }
    options.logger.info("environment_setup_skipped", { reason: "seeded" });
    return;
  }
  if (!setup) return;
  const marker = await readText(options.markerFile);
  if (marker && volumeId) {
    try {
      const done = JSON.parse(marker) as Marker;
      if (done.volumeId === volumeId && done.status === "ok") return;
    } catch {
      /* a broken marker: run the setup again */
    }
  }
  for (;;) {
    if (options.signal?.aborted) return;
    options.logger.info("environment_setup_started", { recipeVersion: setup.recipeVersion });
    const report = await runOnce(options, setup);
    if (report.status === "ok") {
      if (volumeId) {
        const done: Marker = { volumeId, recipeVersion: setup.recipeVersion, status: "ok" };
        await writeAtomic(options.markerFile, new TextEncoder().encode(`${JSON.stringify(done)}\n`));
      }
      await options.host.reportSetup(report).catch((error: unknown) =>
        options.logger.warn("environment_setup_report_failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      options.logger.info("environment_setup_done", { recipeVersion: setup.recipeVersion });
      return;
    }
    options.logger.warn("environment_setup_failed", { index: report.index, exitCode: report.exitCode });
    let reported = false;
    // Report it, then wait until a turn start asks the pod to run again, and run it again.
    for (;;) {
      if (!reported)
        reported = await options.host.reportSetup(report).then(
          () => true,
          () => false,
        );
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? SETUP_RETRY_POLL_MS));
      if (options.signal?.aborted) return;
      if (!reported) continue;
      const state = await options.host.setupState().catch(() => undefined);
      if (!state?.retry) continue;
      if (!state.setup) return;
      setup = state.setup;
      break;
    }
  }
}
