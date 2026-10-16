/**
 * Agent manifests (protocol 16, track T2): `/v1/agent-manifests/{name}`, named and versioned
 * documents with what runs inside an agent's loop (`harness`) and what the Runtime provides
 * around it (`runtime`). They replace agent definitions (`PUT /v1/agents/:id` before protocol
 * 16) and environment manifests.
 *
 * - **Versions.** A save whose manifest hashes the same as the latest answers it unchanged; any
 *   other writes the next version. A version is never changed or deleted alone.
 * - **No Agent changes.** Saving a version reaches no Agent: an Agent is made from one version and
 *   keeps it (`putAgent`; track T3 moves a tracking one on). The plan counts those behind.
 * - **Both sections at once.** The Runtime sees both sections, so it checks them against each
 *   other (`sectionGaps`): every gap is named in one `422 manifest_inconsistent`, which is what
 *   `requires` checked when a session opened before protocol 16. Each section's own checks run
 *   too: the harness's (no code tools, no approvals, HTTP tool timeouts, the skill files) and the
 *   runtime's (the Tenant's limits, its files).
 * - **Plan and drift.** `?dryRun=true` answers what a save would do and saves nothing: the
 *   changes from the latest by section, every reason the Runtime would refuse it, warnings, and
 *   how many Agents stay on older versions. `If-Match: <version>` refuses
 *   (`412 manifest_changed`) a save whose latest version moved since the client read it; `0` asks
 *   for a manifest that does not exist yet.
 * - **Every client is equal** (Q12): a version records who saved it (`savedBy`).
 */
import {
  definitionFilesOf,
  type AgentManifestChange,
  type AgentManifestPlan,
  type AgentManifestV8,
  type AgentManifestVersions,
  type AgentManifestView,
  type AgentManifestWarning,
  type PutAgentManifestRequest,
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
import type { AgentManifestRow, Tx } from "../store/types.js";
import { resolveRecipe, type RecipeRequest } from "../sandbox/resolve.js";
import { declaredSandboxes } from "../sandbox/share.js";
import { httpToolTimeoutIssues } from "../gates/http-tool.js";
import { limitIssues, limitsInForce, manifestShapeIssues, readTenantLimits } from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import type { AuthScope, TenantContext } from "./context.js";
import { actorOf, fileErrors } from "./agents.js";
import { definitionFileIssues } from "./definition-files.js";
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

/** What a save of `manifest` should tell its saver, though it would be saved. */
function warningsOf(ctx: TenantContext, manifest: AgentManifestV8, behind: Map<number, number>): AgentManifestWarning[] {
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
  for (const [version, agents] of [...behind].sort(([a], [b]) => a - b))
    if (agents > 0)
      warnings.push({
        code: "agents_behind",
        message: `${agents} Agent${agents === 1 ? " was" : "s were"} made from ${manifest.name}@${version} and stay${agents === 1 ? "s" : ""} on it until upgrades ship (track T3).`,
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
    const counts = await t.agentsOfManifest(name);
    const behind = new Map([...counts].filter(([version]) => version < to));
    const warnings = warningsOf(ctx, manifest, behind);
    const checked = await errorsOf(t, manifest);
    if (options.dryRun) {
      let behindCount = 0;
      for (const n of behind.values()) behindCount += n;
      return {
        name,
        from: latest?.version ?? null,
        to,
        unchanged,
        changes: unchanged ? [] : sectionChanges(latest?.body, manifest),
        warnings,
        errors: [...gaps, ...checked.errors],
        behind: behindCount,
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
    if (unchanged) return { manifest: viewOf(latest!, counts), unchanged: true, warnings };
    const row: AgentManifestRow = {
      name,
      version: to,
      body: manifest,
      hash,
      savedBy: { actor: actorOf(scope) },
      createdAt: new Date().toISOString(),
    };
    await t.insertAgentManifest(row);
    // Its files by hash, skills' and runtime files' alike, for the sweep that deletes unused ones.
    const shas = new Set(definitionFilesOf(loopManifestOf(manifest)));
    for (const file of runtimeOf(manifest).files ?? []) if ("files" in file) for (const sha of Object.values(file.files)) shas.add(sha);
    if (shas.size > 0) await t.insertDefinitionFileUses(manifestFileOwner(name), hash, [...shas]);
    return { manifest: viewOf(row, counts), unchanged: false, warnings };
  });
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
