/**
 * Agent manifests (protocol 16, track T2): `/v1/agent-manifests/{name}`, named and versioned
 * documents with what runs inside an agent's loop (`harness`) and what the Runtime provides
 * around it (`runtime`). They replace agent definitions (`PUT /v1/agents/:id` before protocol
 * 16) and environment manifests.
 *
 * - **Versions.** A save whose manifest hashes the same as the latest answers it unchanged; any
 *   other writes the next version. A version is never changed or deleted alone.
 * - **Tracking Agents move.** Saving a version moves every Agent that tracks the manifest to it
 *   (track T3, `moveAgent`), in the save's transaction: at once, at its pod's next start, or once
 *   its required secrets are set. A pinned Agent stays, and so does one the version cannot move
 *   (a fixed field) or whose start failed on it. The plan counts both.
 * - **Both sections at once.** The Runtime sees both sections, so it checks them against each
 *   other (`sectionGaps`): every gap is named in one `422 manifest_inconsistent`, which is what
 *   `requires` checked when a session opened before protocol 16. Each section's own checks run
 *   too: the harness's (no code tools, no approvals, HTTP tool timeouts, the skill files) and the
 *   runtime's (the Tenant's limits, its files).
 * - **Plan and drift.** `?dryRun=true` answers what a save would do and saves nothing: the
 *   changes from the latest by section, every reason the Runtime would refuse it, warnings, the
 *   Agents it moves and how many stay on older versions. `If-Match: <version>` refuses
 *   (`412 manifest_changed`) a save whose latest version moved since the client read it; `0` asks
 *   for a manifest that does not exist yet.
 * - **Every client is equal** (Q12): a version records who saved it (`savedBy`).
 * - **Agent folders** (track T6, D79): the same route takes a folder by hash
 *   (`application/vnd.nylorun.folder+json`). The Runtime reads the files the compiler needs from
 *   the definition file store, compiles them with `@nylorun/core/folder` (a folder that does not
 *   compile is `422 folder_invalid`, every diagnostic in `details.diagnostics`), and saves the
 *   manifest as above, with the folder kept as the version's source (`source`, its files recorded
 *   as the version's definition files). A folder whose manifest is unchanged saves no new
 *   version, so its source is not saved either. What a folder may hold is the Tenant's Runtime
 *   limits `folderFiles`, `folderBytes` and `folderTextFileBytes` (track T7), which the compiler
 *   is given too; `source/diff` compares two versions' sources by path and hash.
 */
import {
  compileAgentFolder,
  folderTextPaths,
  type AgentFolderDiagnostic,
  type AgentFolderLimits,
} from "@nylorun/core/folder";
import {
  definitionFilesOf,
  type AgentManifestChange,
  type AgentManifestPlan,
  type AgentManifestSource,
  type AgentManifestSourceDiff,
  type AgentManifestV8,
  type AgentManifestVersions,
  type AgentManifestView,
  type AgentManifestWarning,
  type PutAgentFolderRequest,
  type PutAgentManifestRequest,
  type RuntimeLimits,
  type RuntimeSection,
  type SaveAgentManifestResponse,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import {
  approvalRefusal,
  codeToolRefusal,
  harnessIdOf,
  loopManifestOf,
  runtimeOf,
  sectionGaps,
} from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type { AgentManifestRow, AgentManifestSourceRecord, Environment, Tx } from "../store/types.js";
import { resolveRecipe, type RecipeRequest } from "../sandbox/resolve.js";
import { declaredSandboxes } from "../sandbox/share.js";
import { httpToolTimeoutIssues } from "../gates/http-tool.js";
import { limitIssues, limitsInForce, manifestShapeIssues, readTenantLimits } from "./limits.js";
import { triggerIssues } from "./triggers.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import type { AuthScope, TenantContext } from "./context.js";
import { actorOf, fileErrors } from "./agents.js";
import { moveAgent, planMove } from "./agent-versions.js";
import { definitionFileIssues, openDefinitionFile, readDefinitionFile } from "./definition-files.js";
import { fail } from "./http.js";

/** What a manifest's runtime section asks of an Agent's recipe, with the harness its loop names. */
export function manifestRecipeRequest(manifest: Pick<AgentManifestV8, "harness" | "runtime">): RecipeRequest {
  const runtime: RuntimeSection = runtimeOf(manifest);
  return {
    ...(runtime.image === undefined ? {} : { image: runtime.image }),
    ...(runtime.resources === undefined ? {} : { resources: runtime.resources }),
    ...(runtime.storage === undefined ? {} : { storage: runtime.storage }),
    ...(runtime.network === undefined ? {} : { network: runtime.network }),
    harness: harnessIdOf(manifest.harness),
    ...(runtime.lifecycle === undefined ? {} : { lifecycle: runtime.lifecycle }),
    ...(runtime.setup === undefined ? {} : { setup: runtime.setup }),
    ...(runtime.files === undefined ? {} : { files: runtime.files }),
    ...(runtime.limits === undefined ? {} : { limits: runtime.limits }),
    ...(runtime.secrets === undefined ? {} : { secrets: runtime.secrets }),
  };
}

/** The hash a manifest's version records: equal manifests hash the same. */
export function agentManifestHash(manifest: AgentManifestV8): string {
  return hashManifest(manifest as never);
}

/** The owner a version's definition files are recorded under, for the sweep. */
export function manifestFileOwner(name: string): string {
  return `agent-manifest:${name}`;
}

const notFound = (name: string, version?: number): never =>
  fail(404, version === undefined ? `No agent manifest is named ${name}.` : `Agent manifest ${name} has no version ${version}.`, {
    code: "manifest_not_found",
  });

function viewOf(row: AgentManifestRow, counts: Map<number, number>): AgentManifestView {
  return {
    name: row.name,
    version: row.version,
    hash: row.hash,
    manifest: row.body,
    savedBy: row.savedBy,
    createdAt: row.createdAt,
    agents: counts.get(row.version) ?? 0,
    ...(row.source === undefined
      ? {}
      : { source: { compiler: row.source.compiler, files: row.source.files, bytes: row.source.bytes } }),
  };
}

/** Each field that differs between `before` and `after`, by path; arrays compare whole. */
export function manifestChanges(
  before: unknown,
  after: unknown,
  path = "",
): { path: string; from?: unknown; to?: unknown }[] {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (object(before) && object(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => manifestChanges(before[key], after[key], path ? `${path}.${key}` : key));
  }
  if (canonical(before) === canonical(after)) return [];
  return [
    {
      path,
      ...(before === undefined ? {} : { from: before }),
      ...(after === undefined ? {} : { to: after }),
    },
  ];
}

/**
 * The changes from `before` to `after` by section: `manifest` for the top-level fields, else
 * `harness` or `runtime` with the path inside it. A section added or removed whole is one change.
 */
export function sectionChanges(before: Partial<AgentManifestV8> | undefined, after: AgentManifestV8): AgentManifestChange[] {
  const op = (from: unknown, to: unknown): AgentManifestChange["op"] =>
    from === undefined ? "add" : to === undefined ? "remove" : "replace";
  const changes: AgentManifestChange[] = [];
  const { harness: beforeHarness, runtime: beforeRuntime, ...beforeTop } = before ?? {};
  const { harness, runtime, ...top } = after;
  for (const change of manifestChanges(beforeTop, top))
    changes.push({ section: "manifest", ...change, op: op(change.from, change.to) });
  for (const [section, from, to] of [
    ["harness", beforeHarness, harness],
    ["runtime", beforeRuntime, runtime],
  ] as const) {
    if (from === undefined || to === undefined) {
      if (from !== to)
        changes.push({
          section,
          path: "",
          op: op(from, to),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        });
      continue;
    }
    for (const change of manifestChanges(from, to)) changes.push({ section, ...change, op: op(change.from, change.to) });
  }
  return changes;
}

/** The Agents a save of version `to` moves (track T3), by when it applies, and those that stay behind. */
interface Moves {
  now: number;
  nextStart: number;
  secrets: number;
  behind: number;
}

/**
 * Each live Agent of manifest `name` on another version than `to`, and whether a save of `to`
 * moves it: it tracks the manifest, is not moving to `to` already, and `to` did not fail to start on it.
 */
async function agentsBehind(t: Tx, name: string, to: number): Promise<{ agent: Environment; moves: boolean }[]> {
  return (await t.listEnvironments())
    .filter((agent) => agent.manifestName === name && agent.pod?.desired !== "deleted" && agent.manifestVersion !== to)
    .map((agent) => ({
      agent,
      moves: agent.manifestRef === "tracking" && agent.targetVersion !== to && agent.failedVersion !== to,
    }));
}

/**
 * Plans (or with `apply`, makes) the move of each Agent that tracks manifest `version.name` to
 * `version` (track T3): each under its row lock, in the save's transaction.
 */
async function moveTracking(t: Tx, version: AgentManifestRow, apply: boolean): Promise<Moves> {
  const moves: Moves = { now: 0, nextStart: 0, secrets: 0, behind: 0 };
  const now = new Date().toISOString();
  for (const { agent: listed, moves: tracks } of await agentsBehind(t, version.name, version.version)) {
    const agent = tracks && apply ? await t.environment(listed.id, { lock: true }) : listed;
    if (!agent || !tracks) {
      if (agent && agent.targetVersion !== version.version) moves.behind++;
      continue;
    }
    const move = await planMove(t, agent, version, "tracking");
    if (move.plan.applies === "refused") {
      moves.behind++;
      continue;
    }
    const applies = apply ? await moveAgent(t, agent, move, now) : move.plan.applies;
    if (applies === "now") moves.now++;
    else if (applies === "next_start") moves.nextStart++;
    else if (applies === "secrets") moves.secrets++;
  }
  return moves;
}

/** What a save of `manifest` should tell its saver, though it would be saved. */
function warningsOf(ctx: TenantContext, manifest: AgentManifestV8, to: number, moves: Moves | undefined): AgentManifestWarning[] {
  const warnings: AgentManifestWarning[] = [];
  const runtime = runtimeOf(manifest);
  if (runtime.image !== undefined && !runtime.image.includes("@sha256:"))
    warnings.push({
      code: "image_tag",
      message: `runtime.image ${runtime.image} is a tag, not a digest: each Agent pins what its first pod pulls, so two Tenants may run different bytes.`,
    });
  if (runtime.kind === "pod" && !ctx.pods)
    warnings.push({
      code: "pods_unavailable",
      message: "runtime.kind pod needs sandbox pods, which this Tenant does not have: an Agent made from it is refused until `nylorun local sandbox enable`.",
    });
  if (moves === undefined) return warnings;
  const moved = moves.now + moves.nextStart + moves.secrets;
  if (moved > 0) {
    const parts = [
      ...(moves.now > 0 ? [`${moves.now} at once`] : []),
      ...(moves.nextStart > 0 ? [`${moves.nextStart} at their pod's next start`] : []),
      ...(moves.secrets > 0 ? [`${moves.secrets} once their required secrets are set`] : []),
    ];
    warnings.push({
      code: "agents_move",
      message: `${moved} Agent${moved === 1 ? " tracks" : "s track"} ${manifest.name} and move${moved === 1 ? "s" : ""} to version ${to}: ${parts.join(", ")}.`,
    });
  }
  if (moves.behind > 0)
    warnings.push({
      code: "agents_behind",
      message: `${moves.behind} Agent${moves.behind === 1 ? " stays" : "s stay"} on an older version of ${manifest.name}: pinned, or ${moves.behind === 1 ? "it" : "they"} cannot move to version ${to} (move or fork ${moves.behind === 1 ? "it" : "them"}).`,
    });
  return warnings;
}

/**
 * Every reason the Runtime would refuse `manifest` now, apart from the gaps between its sections:
 * its harness section's own checks and its runtime section's (the Tenant's limits, its files).
 */
async function errorsOf(t: Tx, manifest: AgentManifestV8): Promise<{ errors: string[]; missing: string[]; oversized: { name: string; bytes: number }[]; limitBytes: number }> {
  const loop = loopManifestOf(manifest);
  const errors: string[] = [];
  // The Runtime runs agents from their manifests alone (track R2): no tool may need it.
  const code = codeToolRefusal(loop);
  if (code) errors.push(code);
  // Tool approvals are the Tenant's tool policy, decided at the Tool Gate (R5 step 2).
  const approval = approvalRefusal(loop);
  if (approval) errors.push(approval);
  const declared = declaredSandboxes(loop);
  if (declared.length > 0)
    errors.push(`${declared.join(", ")} declares a sandbox: what an agent runs on is the manifest's runtime section.`);
  const runtimeLimits = await readRuntimeLimits(t);
  errors.push(...httpToolTimeoutIssues(loop, runtimeLimits.httpToolTimeoutMs));
  const runtime = runtimeOf(manifest);
  const config = effectiveSandboxConfig(await readSandboxConfig(t));
  const resolved = resolveRecipe(runtime.kind, manifestRecipeRequest(manifest), config);
  const tenantLimits = await readTenantLimits(t);
  errors.push(
    ...(resolved.kind === "error" ? resolved.errors : []),
    ...limitIssues(runtime.limits, tenantLimits),
    ...manifestShapeIssues({ ...runtime, ...(manifest.description === undefined ? {} : { description: manifest.description }) }, runtimeLimits),
    ...(await fileErrors(t, runtime.files)),
    ...triggerIssues(runtime.triggers, runtimeLimits),
  );
  // A skill's files count against the manifest's own skill limit, never above the Tenant's.
  const limitBytes = limitsInForce(tenantLimits, runtime.limits).skills.totalBytes;
  const { missing, oversized } = await definitionFileIssues(t, loop, limitBytes);
  if (missing.length > 0)
    errors.push(
      `The manifest names ${missing.length} file(s) the Runtime does not hold; upload each with PUT /v1/files/<sha256> first: ${missing.join(", ")}`,
    );
  if (oversized.length > 0)
    errors.push(
      `A skill's files may hold at most ${limitBytes} bytes together: ${oversized.map((skill) => `'${skill.name}' holds ${skill.bytes}`).join(", ")}`,
    );
  return { errors, missing, oversized, limitBytes };
}

/**
 * `PUT /v1/agent-manifests/{name}`: saves `body` as manifest `name`'s next version, or answers
 * the latest unchanged; with `dryRun`, the plan of that save and nothing saved.
 */
export async function saveAgentManifest(
  ctx: TenantContext,
  name: string,
  body: PutAgentManifestRequest,
  scope: AuthScope,
  options: { dryRun: true; ifMatch?: number },
): Promise<AgentManifestPlan>;
export async function saveAgentManifest(
  ctx: TenantContext,
  name: string,
  body: PutAgentManifestRequest,
  scope: AuthScope,
  options?: { dryRun?: false; ifMatch?: number },
): Promise<SaveAgentManifestResponse>;
export async function saveAgentManifest(
  ctx: TenantContext,
  name: string,
  body: PutAgentManifestRequest,
  scope: AuthScope,
  options: { dryRun?: boolean; ifMatch?: number } = {},
): Promise<AgentManifestPlan | SaveAgentManifestResponse> {
  const { requestId: _, ...manifest } = body;
  if (manifest.name !== name)
    fail(400, `The manifest is named ${manifest.name}, and the path names ${name}: they must match.`);
  return saveManifest(ctx, name, manifest, scope, options);
}

/** What a folder save adds to a manifest save: the source to keep, and the compiler's notes. */
interface FolderSave {
  readonly source: AgentManifestSourceRecord;
  readonly diagnostics: readonly AgentFolderDiagnostic[];
  readonly compiler: string;
}

async function saveManifest(
  ctx: TenantContext,
  name: string,
  manifest: AgentManifestV8,
  scope: AuthScope,
  options: { dryRun?: boolean; ifMatch?: number },
  folder?: FolderSave,
): Promise<AgentManifestPlan | SaveAgentManifestResponse> {
  const hash = agentManifestHash(manifest);
  const gaps = sectionGaps(manifest);
  return ctx.store.tx(async (t) => {
    await t.lockAgentManifest(name);
    const latest = await t.agentManifest(name);
    if (options.ifMatch !== undefined && (latest?.version ?? 0) !== options.ifMatch)
      fail(
        412,
        latest === undefined
          ? `Agent manifest ${name} does not exist, and If-Match named version ${options.ifMatch}.`
          : `Agent manifest ${name} is at version ${latest.version}, not ${options.ifMatch}: someone saved it since you read it. Read it again, or save without If-Match to replace it.`,
        { code: "manifest_changed", details: { latest: latest?.version ?? 0 } },
      );
    const unchanged = latest?.hash === hash;
    const to = unchanged ? latest!.version : (latest?.version ?? 0) + 1;
    // A folder whose manifest is unchanged keeps the latest version, and with it that version's source.
    const notes =
      folder === undefined
        ? undefined
        : unchanged && canonical(latest?.source?.entries ?? null) !== canonical(folder.source.entries)
          ? [
              ...folder.diagnostics,
              {
                severity: "note" as const,
                code: "source_not_saved",
                message: "Source files changed that are not part of the agent; the manifest is unchanged, so no version is saved",
              },
            ]
          : folder.diagnostics;
    const counts = await t.agentsOfManifest(name);
    const checked = await errorsOf(t, manifest);
    // The version as it would be saved, for the plan of the Agents it moves.
    const row: AgentManifestRow = unchanged
      ? latest!
      : {
          name,
          version: to,
          body: manifest,
          hash,
          savedBy: { actor: actorOf(scope) },
          createdAt: new Date().toISOString(),
          ...(folder === undefined ? {} : { source: folder.source }),
        };
    if (options.dryRun) {
      const errors = [...gaps, ...checked.errors];
      // A save with errors moves nothing; one that changes nothing moves no Agent either.
      const moves = errors.length > 0 || unchanged ? undefined : await moveTracking(t, row, false);
      return {
        name,
        from: latest?.version ?? null,
        to,
        unchanged,
        changes: unchanged ? [] : sectionChanges(latest?.body, manifest),
        warnings: warningsOf(ctx, manifest, to, moves),
        errors,
        behind: moves?.behind ?? (await agentsBehind(t, name, to)).length,
        moves: { now: moves?.now ?? 0, nextStart: moves?.nextStart ?? 0, secrets: moves?.secrets ?? 0 },
        ...(folder === undefined ? {} : { manifest, diagnostics: [...notes!], compiler: folder.compiler }),
      };
    }
    if (gaps.length > 0)
      fail(422, `Agent manifest ${name}'s harness and runtime sections do not fit: ${gaps.join("; ")}.`, {
        code: "manifest_inconsistent",
        details: { gaps },
      });
    if (checked.missing.length > 0)
      fail(400, checked.errors.find((error) => error.startsWith("The manifest names"))!, {
        code: "definition_files_missing",
        details: { missing: checked.missing },
      });
    if (checked.oversized.length > 0)
      fail(413, `This manifest allows a skill's files at most ${checked.limitBytes} bytes together: ${checked.oversized.map((skill) => `'${skill.name}' holds ${skill.bytes}`).join(", ")}`, {
        code: "limit_exceeded",
        details: { limitBytes: checked.limitBytes, skills: checked.oversized },
      });
    if (checked.errors.length > 0) fail(400, checked.errors.join(" "));
    const folderNotes = notes === undefined ? {} : { diagnostics: [...notes] };
    if (unchanged)
      return { manifest: viewOf(latest!, counts), unchanged: true, warnings: warningsOf(ctx, manifest, to, undefined), ...folderNotes };
    await t.insertAgentManifest(row);
    // Its files by hash, skills' and runtime files' alike, for the sweep that deletes unused ones.
    const shas = new Set(definitionFilesOf(loopManifestOf(manifest)));
    for (const file of runtimeOf(manifest).files ?? []) if ("files" in file) for (const sha of Object.values(file.files)) shas.add(sha);
    // A folder's every file too: the version keeps its source.
    for (const entry of folder?.source.entries ?? []) shas.add(`sha256:${entry.sha256}`);
    if (shas.size > 0) await t.insertDefinitionFileUses(manifestFileOwner(name), hash, [...shas]);
    // Every Agent that tracks the manifest moves to the new version (track T3).
    const moves = await moveTracking(t, row, true);
    return {
      manifest: viewOf(row, await t.agentsOfManifest(name)),
      unchanged: false,
      warnings: warningsOf(ctx, manifest, to, moves),
      ...folderNotes,
    };
  });
}

/**
 * `PUT /v1/agent-manifests/{name}` with an agent folder by hash (track T6): reads the files the
 * compiler needs from the definition file store, compiles the folder (`422 folder_invalid` when
 * it does not), then saves or plans the manifest as a JSON save does, keeping the folder as the
 * version's source.
 */
export async function saveAgentFolder(
  ctx: TenantContext,
  name: string,
  body: PutAgentFolderRequest,
  scope: AuthScope,
  options: { dryRun?: boolean; ifMatch?: number } = {},
): Promise<AgentManifestPlan | SaveAgentManifestResponse> {
  const entries = [...body.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const limits = folderLimitsOf(await ctx.store.tx((t) => readRuntimeLimits(t)));
  if (entries.length > limits.files)
    fail(413, `An agent folder holds at most ${limits.files} files (the Runtime limit folderFiles); this one holds ${entries.length}`, {
      code: "limit_exceeded",
      details: { limit: "folderFiles", value: limits.files },
    });
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (bytes > limits.totalBytes)
    fail(413, `An agent folder holds at most ${limits.totalBytes} bytes (the Runtime limit folderBytes); this one holds ${bytes}`, {
      code: "limit_exceeded",
      details: { limit: "folderBytes", value: limits.totalBytes },
    });
  // Every file must be held: the version keeps them all as its source.
  const shas = [...new Set(entries.map((entry) => `sha256:${entry.sha256}`))].sort();
  const held = await ctx.store.tx((t) => t.heldDefinitionFiles(shas));
  const missing = entries.filter((entry) => !held.has(`sha256:${entry.sha256}`));
  if (missing.length > 0)
    fail(
      400,
      `The folder names ${missing.length} file(s) the Runtime does not hold; upload each with PUT /v1/files/sha256:<hex> first: ${missing
        .slice(0, 20)
        .map((entry) => entry.path)
        .join(", ")}`,
      { code: "definition_files_missing", details: { missing: missing.map((entry) => `sha256:${entry.sha256}`) } },
    );
  for (const entry of entries)
    if (held.get(`sha256:${entry.sha256}`) !== entry.size)
      fail(400, `${entry.path} is listed with ${entry.size} bytes, and the Runtime holds ${held.get(`sha256:${entry.sha256}`)} for its hash`);
  // The files the compiler reads, each at most the text file limit (it reports a larger one).
  const files = new Map<string, Uint8Array>();
  for (const path of folderTextPaths(entries)) {
    const entry = entries.find((item) => item.path === path)!;
    if (entry.size > limits.textFileBytes) continue;
    const bytes = await readDefinitionFile(ctx.blobs, `sha256:${entry.sha256}`);
    if (bytes) files.set(path, bytes);
  }
  const compiled = compileAgentFolder({ entries, files, name, limits });
  if (!compiled.manifest) {
    const errors = compiled.diagnostics.filter((item) => item.severity === "error");
    fail(422, `Agent folder ${name} does not compile: ${errors.length} error(s), the first: ${located(errors[0])}`, {
      code: "folder_invalid",
      details: { diagnostics: compiled.diagnostics },
    });
  }
  const source: AgentManifestSourceRecord = {
    compiler: compiled.compiler,
    files: entries.length,
    bytes,
    entries: entries.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })),
  };
  return saveManifest(ctx, name, compiled.manifest!, scope, options, {
    source,
    diagnostics: compiled.diagnostics,
    compiler: compiled.compiler,
  });
}

/** What a folder may hold: the Tenant's Runtime limits, as the compiler takes them. */
function folderLimitsOf(limits: Pick<RuntimeLimits, "folderFiles" | "folderBytes" | "folderTextFileBytes">): AgentFolderLimits {
  return { files: limits.folderFiles, totalBytes: limits.folderBytes, textFileBytes: limits.folderTextFileBytes };
}

/** A diagnostic as a person reads it: `file:line:column message`. */
function located(diagnostic: AgentFolderDiagnostic | undefined): string {
  if (!diagnostic) return "unknown";
  const where = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""} `
    : "";
  return `${where}${diagnostic.message}`;
}

/** The source of version `version` of manifest `name`, or a `404` for one saved as JSON. */
async function sourceOf(ctx: TenantContext, name: string, version: number): Promise<AgentManifestSourceRecord> {
  const row = (await ctx.store.tx((t) => t.agentManifest(name, version))) ?? notFound(name, version);
  if (!row.source)
    fail(404, `Version ${version} of agent manifest ${name} was saved as JSON: it has no source.`, { code: "not_found" });
  return row.source!;
}

/** `GET /v1/agent-manifests/{name}/versions/{v}/source`: the folder a version was compiled from. */
export async function getAgentManifestSource(ctx: TenantContext, name: string, version: number): Promise<AgentManifestSource> {
  const source = await sourceOf(ctx, name, version);
  return { name, version, ...source };
}

/** `GET .../versions/{v}/source/files/{path}`: one file of a version's source, streamed. */
export async function readAgentManifestSourceFile(
  ctx: TenantContext,
  name: string,
  version: number,
  path: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
  const source = await sourceOf(ctx, name, version);
  const entry = source.entries.find((item) => item.path === path);
  if (!entry) fail(404, `Version ${version} of agent manifest ${name} has no file ${path}.`, { code: "not_found" });
  const body = await openDefinitionFile(ctx.blobs, `sha256:${entry!.sha256}`);
  if (!body) fail(404, `The Runtime no longer holds ${path} of version ${version} of agent manifest ${name}.`, { code: "not_found" });
  return { body: body!, size: entry!.size };
}

/**
 * `GET /v1/agent-manifests/{name}/source/diff?from=&to=`: the files added, removed and changed
 * (by SHA-256) from version `from`'s source to version `to`'s; a `404` when either was saved as JSON.
 */
export async function diffAgentManifestSources(
  ctx: TenantContext,
  name: string,
  from: number,
  to: number,
): Promise<AgentManifestSourceDiff> {
  const before = new Map((await sourceOf(ctx, name, from)).entries.map((entry) => [entry.path, entry]));
  const after = (await sourceOf(ctx, name, to)).entries;
  const diff: AgentManifestSourceDiff = { name, from, to, added: [], removed: [], changed: [], unchanged: 0 };
  for (const entry of after) {
    const was = before.get(entry.path);
    before.delete(entry.path);
    if (!was) diff.added.push(entry);
    else if (was.sha256 === entry.sha256) diff.unchanged++;
    else
      diff.changed.push({
        path: entry.path,
        from: { size: was.size, sha256: was.sha256 },
        to: { size: entry.size, sha256: entry.sha256 },
      });
  }
  diff.removed.push(...before.values());
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  diff.added.sort(byPath);
  diff.removed.sort(byPath);
  diff.changed.sort(byPath);
  return diff;
}

/** `GET /v1/agent-manifests/{name}` (the latest) and `.../versions/{n}`. */
export async function getAgentManifest(ctx: TenantContext, name: string, version?: number): Promise<AgentManifestView> {
  return ctx.store.tx(async (t) => {
    const row = (await t.agentManifest(name, version)) ?? notFound(name, version);
    return viewOf(row, await t.agentsOfManifest(name));
  });
}

/** `GET /v1/agent-manifests`: each manifest's latest version. */
export async function listAgentManifests(ctx: TenantContext): Promise<{ manifests: AgentManifestView[] }> {
  return ctx.store.tx(async (t) => {
    const manifests: AgentManifestView[] = [];
    for (const row of await t.listAgentManifests()) manifests.push(viewOf(row, await t.agentsOfManifest(row.name)));
    return { manifests };
  });
}

/** `GET /v1/agent-manifests/{name}/versions`: every version, newest first. */
export async function agentManifestVersions(ctx: TenantContext, name: string): Promise<AgentManifestVersions> {
  return ctx.store.tx(async (t) => {
    const rows = await t.agentManifestVersions(name);
    if (rows.length === 0) notFound(name);
    const counts = await t.agentsOfManifest(name);
    return {
      name,
      latest: rows[0]!.version,
      versions: rows.map((row) => ({
        version: row.version,
        hash: row.hash,
        savedBy: row.savedBy,
        createdAt: row.createdAt,
        agents: counts.get(row.version) ?? 0,
      })),
    };
  });
}

/**
 * `DELETE /v1/agent-manifests/{name}`: deletes every version, refused while any Agent was made
 * from one (`409 manifest_in_use`): the Agent names the version it runs.
 */
export async function deleteAgentManifest(ctx: TenantContext, name: string): Promise<{ name: string; deleted: boolean }> {
  return ctx.store.tx(async (t) => {
    await t.lockAgentManifest(name);
    let made = 0;
    for (const n of (await t.agentsOfManifest(name)).values()) made += n;
    if (made > 0)
      fail(409, `${made} Agent(s) were made from agent manifest ${name}: delete them first, or keep the manifest.`, {
        code: "manifest_in_use",
        details: { agents: made },
      });
    return { name, deleted: (await t.deleteAgentManifest(name)) > 0 };
  });
}
