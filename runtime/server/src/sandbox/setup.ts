/**
 * Setup and input files (R2d step 2, Host feature `environment-setup`): what a pod Environment's
 * engine runs and copies when its disk is made or reset, before it takes any turn. The plan is
 * the applied recipe's `setup` and `files`, handed to the engine with its host token (the join
 * answer, and `GET host/setup` while it waits to retry, or, on a fork onto other setup, for its
 * disk version to be written: Q17); the engine keeps a marker on the volume
 * (`/harness/setup.json`), so a resume never runs it again and a reset (a new volume) does.
 *
 * Input files come only through the routes here, indexed into the applied recipe's `files`:
 * a pod reads the artifact versions and the definition files by hash (Q6) its own recipe names,
 * and nothing else of the Object store.
 *
 * The plan's `setupHash` names its commands and files: the engine runs the setup again on a volume
 * whose marker names another (a new version's setup, track T3).
 *
 * A failed command fails the pod (`observed: failed`, a reason that starts `setup:`, and
 * `agent.failed` with the command, its exit code and the end of its output), or, on a start on
 * a new version, takes the Agent back to the version it ran (`revertStart`, T3): the turn that
 * waits for it fails with that reason (`podUnusable`, `tenant/advance.ts`), the failure stays
 * until a turn start asks the pod to run again (`wantRunning`), and the engine, polling, runs the
 * setup again then.
 */
import {
  ENVIRONMENT_SETUP_TIMEOUT_DEFAULT,
  type EnvironmentRecipe,
  type FolderManifest,
} from "@nylorun/core/contracts";
import { createHash } from "node:crypto";
import { parseSandboxDuration } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import { contentKey, readManifest } from "../artifacts/folders.js";
import { contentTypeFor } from "@nylorun/core/contracts";
import { definitionFileKey } from "../tenant/definition-files.js";
import type { Environment, Tx } from "../store/types.js";
import type { TenantContext } from "../tenant/context.js";
import { SETUP_FAILED } from "./pods/lifecycle.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { revertStart } from "../tenant/agent-versions.js";

export { SETUP_FAILED };


/** What the engine runs on a new disk. */
export interface SetupPlan {
  /** The applied recipe's version: written into the volume's marker. */
  readonly recipeVersion: number;
  /** The sha256 of the commands and files: a marker with another runs the setup again (T3). */
  readonly setupHash: string;
  readonly commands: readonly { readonly command: string; readonly cwd: string; readonly timeoutMs: number }[];
  /** Each input file by its index into the recipe's `files`, and where it goes. */
  readonly files: readonly { readonly index: number; readonly path: string }[];
  /** Variables every command gets: secrets as the sentinel, plain values (R2c). */
  readonly environment: Readonly<Record<string, string>>;
}

/** The setup of `recipe`, or undefined when it has neither commands nor files. */
export async function setupPlanOf(
  ctx: TenantContext,
  t: Tx,
  environment: Environment,
): Promise<SetupPlan | undefined> {
  const recipe = environment.applied;
  if (!recipe.setup?.length && !recipe.files?.length) return undefined;
  // A command's own timeout, else the default, within the Tenant's `setupCommandMs` as it is now.
  const { setupCommandMs } = await readRuntimeLimits(t);
  const timeoutOf = (timeout: string | undefined) =>
    Math.min(parseSandboxDuration(timeout ?? ENVIRONMENT_SETUP_TIMEOUT_DEFAULT)!, setupCommandMs);
  return {
    recipeVersion: environment.appliedVersion,
    setupHash: createHash("sha256").update(canonical({ setup: recipe.setup ?? [], files: recipe.files ?? [] })).digest("hex"),
    commands: (recipe.setup ?? []).map((command) => ({
      command: command.command,
      cwd: command.cwd ?? "/workspace",
      timeoutMs: timeoutOf(command.timeout),
    })),
    files: (recipe.files ?? []).map((file, index) => ({ index, path: file.path })),
    environment: await ctx.vault.environmentVariables(t, environment.id),
  };
}

/** What the engine reports after running a setup. */
export interface SetupReport {
  readonly status: "ok" | "failed";
  /** The failed command's index into the plan's commands; absent for an input file. */
  readonly index?: number;
  readonly exitCode?: number;
  /** The end of the failed command's output, or why an input file could not be copied. */
  readonly output?: string;
}

export function parseSetupReport(value: unknown): SetupReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as Record<string, unknown>;
  if (report.status !== "ok" && report.status !== "failed") return undefined;
  const index = typeof report.index === "number" && Number.isInteger(report.index) ? report.index : undefined;
  const exitCode = typeof report.exitCode === "number" && Number.isInteger(report.exitCode) ? report.exitCode : undefined;
  const output = typeof report.output === "string" ? report.output : undefined;
  return {
    status: report.status,
    ...(index === undefined ? {} : { index }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(output === undefined ? {} : { output }),
  };
}

/**
 * Records a failed setup on Environment `id` held at host epoch `epoch` (the reporting engine's):
 * the pod is `failed` with a reason that starts `setup:`, and `agent.failed` says which
 * command failed and how, with the end of its output (the Tenant's `setupOutputChars`; the reason
 * quotes `setupReasonChars` of it and `setupCommandExcerptChars` of the command). A report
 * from an older host, or a success, changes nothing.
 */
export async function recordSetup(
  ctx: TenantContext,
  id: string,
  epoch: number,
  report: SetupReport,
): Promise<void> {
  await ctx.store.tx(async (t) => {
    const environment = await t.environment(id, { lock: true });
    const pod = environment?.pod;
    if (!environment || !pod || pod.hostEpoch !== epoch || pod.desired !== "running") return;
    if (report.status === "ok") {
      // A fork's setup ran on its written disk (Q17): its turns may start.
      if (environment.diskSeed?.setup && environment.diskSeed.written)
        await t.updateEnvironment(id, { diskSeed: null }, new Date().toISOString());
      return;
    }
    const { setupOutputChars, setupReasonChars, setupCommandExcerptChars } = await readRuntimeLimits(t);
    const output = (report.output ?? "").slice(-setupOutputChars);
    const command = report.index === undefined ? undefined : environment.applied.setup?.[report.index];
    const what =
      command === undefined ? "copying the input files failed" : `command ${report.index! + 1} (${command.command.slice(0, setupCommandExcerptChars)}) exited ${report.exitCode ?? "abnormally"}`;
    const tail = output.trim().slice(-setupReasonChars);
    const reason = `${SETUP_FAILED} ${what}${tail ? `: ${tail}` : ""}`;
    await t.agentEvent(id, "agent.failed", {
      reason,
      setup: {
        ...(report.index === undefined ? {} : { index: report.index }),
        ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
        output,
      },
    });
    // On a start on a new version (track T3), back to the version it ran; else failed.
    if (!(await revertStart(t, environment, reason, new Date().toISOString())))
      await t.updateEnvironmentPod(id, { observed: "failed", reason }, new Date().toISOString());
  });
  if (report.status === "failed")
    ctx.config.logger.warn("environment setup failed", { environmentId: id, index: report.index, exitCode: report.exitCode });
  else ctx.config.logger.info("environment setup done", { environmentId: id });
}

/**
 * Whether the engine of `id` should run its setup (again): the pod is no longer `failed`, and
 * the disk version a fork starts from is written (Q17).
 */
export async function setupState(
  ctx: TenantContext,
  id: string,
): Promise<{ retry: boolean; setup?: SetupPlan }> {
  return ctx.store.tx(async (t) => {
    const environment = await t.environment(id);
    const pod = environment?.pod;
    if (!environment || !pod) return { retry: false };
    if (pod.observed === "failed") return { retry: false };
    if (environment.diskSeed && !environment.diskSeed.written) return { retry: false };
    const setup = await setupPlanOf(ctx, t, environment);
    return { retry: true, ...(setup ? { setup } : {}) };
  });
}

/** One input file's bytes, or a folder's listing (`path` absent). */
export type SetupFile =
  | { readonly kind: "file"; readonly contentType: string; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: "folder"; readonly entries: readonly { readonly path: string; readonly size: number }[] };

/**
 * Input file `index` of Environment `id`'s applied recipe: a file artifact's bytes, a folder's
 * listing, or (with `path`) one of the folder's files. Undefined when there is no such file.
 */
export async function setupFile(
  ctx: TenantContext,
  id: string,
  index: number,
  path: string | undefined,
): Promise<SetupFile | undefined> {
  const entry = await ctx.store.tx(async (t) => {
    const environment = await t.environment(id);
    return environment?.applied.files?.[index] as NonNullable<EnvironmentRecipe["files"]>[number] | undefined;
  });
  if (!entry) return undefined;
  if ("files" in entry) {
    // Files by hash (Q6): a folder of definition files.
    if (path === undefined) {
      const sizes = await ctx.store.tx(async (t) => {
        const found = new Map<string, number>();
        for (const sha256 of new Set(Object.values(entry.files))) {
          const row = await t.definitionFile(sha256);
          if (row) found.set(sha256, row.size);
        }
        return found;
      });
      return {
        kind: "folder",
        entries: Object.entries(entry.files).map(([item, sha256]) => ({ path: item, size: sizes.get(sha256) ?? 0 })),
      };
    }
    const sha256 = Object.hasOwn(entry.files, path) ? entry.files[path] : undefined;
    if (sha256 === undefined) return undefined;
    const got = await ctx.blobs.get(definitionFileKey(sha256));
    return got ? { kind: "file", contentType: contentTypeFor(path), body: got.body } : undefined;
  }
  const file = entry;
  const found = await ctx.store.tx(async (t) => {
    const artifact = await t.artifact(file.artifactId);
    if (!artifact || artifact.sessionId !== null) return undefined;
    const version = await t.artifactVersion(file.artifactId, file.version);
    return version ? { artifact, version } : undefined;
  });
  if (!found) return undefined;
  if (found.artifact.kind === "file") {
    if (path !== undefined) return undefined;
    const got = await ctx.blobs.get(found.version.blobKey);
    return got ? { kind: "file", contentType: found.version.contentType ?? found.artifact.contentType, body: got.body } : undefined;
  }
  const manifest: FolderManifest = await readManifest(ctx.blobs, found.version);
  if (path === undefined)
    return {
      kind: "folder",
      entries: manifest.entries
        .filter((entry) => entry.type === undefined)
        .map((entry) => ({ path: entry.path, size: entry.size })),
    };
  const listed = manifest.entries.find((item) => item.path === path && item.type === undefined);
  if (!listed) return undefined;
  const got = await ctx.blobs.get(contentKey(listed.sha256));
  return got ? { kind: "file", contentType: listed.contentType, body: got.body } : undefined;
}
