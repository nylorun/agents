/**
 * Environment manifests (protocol 14, D63): `/v1/environment-manifests/{name}`, named and
 * versioned definitions of a kind of Environment, saved like agents.
 *
 * - **Versions.** A save whose manifest hashes the same as the latest answers it unchanged;
 *   any other writes the next version. A version is never changed or deleted alone.
 * - **No Environment changes.** Saving a version reaches no Environment: an Environment is made
 *   from one version and keeps it for life (`putEnvironment`). The plan counts those behind.
 * - **Plan and drift.** `?dryRun=true` answers what a save would do and saves nothing: the
 *   changes from the latest, every reason the Runtime would refuse it (the Tenant's limits,
 *   missing artifacts), warnings, and how many Environments stay on older versions.
 *   `If-Match: <version>` refuses (`412 manifest_changed`) a save whose latest version moved
 *   since the client read it; `0` asks for a manifest that does not exist yet.
 * - **Every client is equal** (Q12): a version records who saved it (`savedBy`), and nothing is
 *   read-only by where it was saved from.
 */
import {
  type EnvironmentManifest,
  type EnvironmentManifestPlan,
  type EnvironmentManifestVersions,
  type EnvironmentManifestView,
  type EnvironmentManifestWarning,
  type PutEnvironmentManifestRequest,
  type SaveEnvironmentManifestResponse,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import { canonical } from "../store/canonical.js";
import type { EnvironmentManifestRow, Tx } from "../store/types.js";
import { resolveRecipe, type RecipeRequest } from "../sandbox/resolve.js";
import { limitIssues, manifestShapeIssues, readTenantLimits } from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import type { AuthScope, TenantContext } from "./context.js";
import { actorOf, fileErrors } from "./environments.js";
import { fail } from "./http.js";

/** What an environment manifest asks of an Environment's recipe. */
export function manifestRecipeRequest(manifest: EnvironmentManifest): RecipeRequest {
  return {
    ...(manifest.image === undefined ? {} : { image: manifest.image }),
    ...(manifest.resources === undefined ? {} : { resources: manifest.resources }),
    ...(manifest.storage === undefined ? {} : { storage: manifest.storage }),
    ...(manifest.network === undefined ? {} : { network: manifest.network }),
    ...(manifest.harness === undefined ? {} : { harness: manifest.harness }),
    ...(manifest.lifecycle === undefined ? {} : { lifecycle: manifest.lifecycle }),
    ...(manifest.setup === undefined ? {} : { setup: manifest.setup }),
    ...(manifest.files === undefined ? {} : { files: manifest.files }),
    ...(manifest.limits === undefined ? {} : { limits: manifest.limits }),
    ...(manifest.secrets === undefined ? {} : { secrets: manifest.secrets }),
  };
}

/** The hash a manifest's version records: equal manifests hash the same. */
export function environmentManifestHash(manifest: EnvironmentManifest): string {
  return hashManifest(manifest as never);
}

const notFound = (name: string, version?: number): never =>
  fail(404, version === undefined ? `No environment manifest is named ${name}.` : `Environment manifest ${name} has no version ${version}.`, {
    code: "manifest_not_found",
  });

function viewOf(row: EnvironmentManifestRow, counts: Map<number, number>): EnvironmentManifestView {
  return {
    name: row.name,
    version: row.version,
    hash: row.hash,
    manifest: row.body,
    savedBy: row.savedBy,
    createdAt: row.createdAt,
    environments: counts.get(row.version) ?? 0,
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

/** What a save of `manifest` should tell its saver, though it would be saved. */
function warningsOf(ctx: TenantContext, manifest: EnvironmentManifest): EnvironmentManifestWarning[] {
  const warnings: EnvironmentManifestWarning[] = [];
  if (manifest.image !== undefined && !manifest.image.includes("@sha256:"))
    warnings.push({
      code: "image_tag",
      message: `image ${manifest.image} is a tag, not a digest: each Environment pins what its first pod pulls, so two Tenants may run different bytes.`,
    });
  if (manifest.kind === "pod" && !ctx.pods)
    warnings.push({
      code: "pods_unavailable",
      message: "kind pod needs sandbox pods, which this Tenant does not have: an Environment made from it is refused until `nylorun local sandbox enable`.",
    });
  return warnings;
}

/** Every reason the Runtime would refuse `manifest` now: the Tenant's limits and its files. */
async function errorsOf(t: Tx, manifest: EnvironmentManifest): Promise<string[]> {
  const config = effectiveSandboxConfig(await readSandboxConfig(t));
  const resolved = resolveRecipe(manifest.kind ?? "virtual", manifestRecipeRequest(manifest), config);
  return [
    ...(resolved.kind === "error" ? resolved.errors : []),
    ...limitIssues(manifest.limits, await readTenantLimits(t)),
    ...manifestShapeIssues(manifest, await readRuntimeLimits(t)),
    ...(await fileErrors(t, manifest.files)),
  ];
}

/**
 * `PUT /v1/environment-manifests/{name}`: saves `body` as manifest `name`'s next version, or
 * answers the latest unchanged; with `dryRun`, the plan of that save and nothing saved.
 */
export async function saveEnvironmentManifest(
  ctx: TenantContext,
  name: string,
  body: PutEnvironmentManifestRequest,
  scope: AuthScope,
  options: { dryRun: true; ifMatch?: number },
): Promise<EnvironmentManifestPlan>;
export async function saveEnvironmentManifest(
  ctx: TenantContext,
  name: string,
  body: PutEnvironmentManifestRequest,
  scope: AuthScope,
  options?: { dryRun?: false; ifMatch?: number },
): Promise<SaveEnvironmentManifestResponse>;
export async function saveEnvironmentManifest(
  ctx: TenantContext,
  name: string,
  body: PutEnvironmentManifestRequest,
  scope: AuthScope,
  options: { dryRun?: boolean; ifMatch?: number } = {},
): Promise<EnvironmentManifestPlan | SaveEnvironmentManifestResponse> {
  const { requestId: _, ...manifest } = body;
  if (manifest.name !== name)
    fail(400, `The manifest is named ${manifest.name}, and the path names ${name}: they must match.`);
  const hash = environmentManifestHash(manifest);
  const warnings = warningsOf(ctx, manifest);
  return ctx.store.tx(async (t) => {
    await t.lockEnvironmentManifest(name);
    const latest = await t.environmentManifest(name);
    if (options.ifMatch !== undefined && (latest?.version ?? 0) !== options.ifMatch)
      fail(
        412,
        latest === undefined
          ? `Environment manifest ${name} does not exist, and If-Match named version ${options.ifMatch}.`
          : `Environment manifest ${name} is at version ${latest.version}, not ${options.ifMatch}: someone saved it since you read it. Read it again, or save without If-Match to replace it.`,
        { code: "manifest_changed", details: { latest: latest?.version ?? 0 } },
      );
    const unchanged = latest?.hash === hash;
    const to = unchanged ? latest!.version : (latest?.version ?? 0) + 1;
    const counts = await t.environmentsOfManifest(name);
    const errors = await errorsOf(t, manifest);
    if (options.dryRun) {
      let behind = 0;
      for (const [version, n] of counts) if (version < to) behind += n;
      return {
        name,
        from: latest?.version ?? null,
        to,
        unchanged,
        changes: unchanged ? [] : manifestChanges(latest?.body ?? {}, manifest),
        warnings,
        errors,
        behind,
      };
    }
    if (errors.length > 0) fail(400, errors.join(" "));
    if (unchanged) return { manifest: viewOf(latest!, counts), unchanged: true, warnings };
    const row: EnvironmentManifestRow = {
      name,
      version: to,
      body: manifest,
      hash,
      savedBy: { actor: actorOf(scope) },
      createdAt: new Date().toISOString(),
    };
    await t.insertEnvironmentManifest(row);
    // Its files by hash (Q6), recorded as a definition's are, for the sweep that deletes unused ones.
    const shas = [...new Set((manifest.files ?? []).flatMap((file) => ("files" in file ? Object.values(file.files) : [])))];
    if (shas.length > 0) await t.insertDefinitionFileUses(`environment-manifest:${name}`, hash, shas);
    return { manifest: viewOf(row, counts), unchanged: false, warnings };
  });
}

/** `GET /v1/environment-manifests/{name}` (the latest) and `.../versions/{n}`. */
export async function getEnvironmentManifest(
  ctx: TenantContext,
  name: string,
  version?: number,
): Promise<EnvironmentManifestView> {
  return ctx.store.tx(async (t) => {
    const row = (await t.environmentManifest(name, version)) ?? notFound(name, version);
    return viewOf(row, await t.environmentsOfManifest(name));
  });
}

/** `GET /v1/environment-manifests`: each manifest's latest version. */
export async function listEnvironmentManifests(ctx: TenantContext): Promise<{ manifests: EnvironmentManifestView[] }> {
  return ctx.store.tx(async (t) => {
    const manifests: EnvironmentManifestView[] = [];
    for (const row of await t.listEnvironmentManifests())
      manifests.push(viewOf(row, await t.environmentsOfManifest(row.name)));
    return { manifests };
  });
}

/** `GET /v1/environment-manifests/{name}/versions`: every version, newest first. */
export async function environmentManifestVersions(ctx: TenantContext, name: string): Promise<EnvironmentManifestVersions> {
  return ctx.store.tx(async (t) => {
    const rows = await t.environmentManifestVersions(name);
    if (rows.length === 0) notFound(name);
    const counts = await t.environmentsOfManifest(name);
    return {
      name,
      latest: rows[0]!.version,
      versions: rows.map((row) => ({
        version: row.version,
        hash: row.hash,
        savedBy: row.savedBy,
        createdAt: row.createdAt,
        environments: counts.get(row.version) ?? 0,
      })),
    };
  });
}

/**
 * `DELETE /v1/environment-manifests/{name}`: deletes every version, refused while any Environment
 * was made from one (`409 manifest_in_use`): the Environment names the version it runs.
 */
export async function deleteEnvironmentManifest(ctx: TenantContext, name: string): Promise<{ name: string; deleted: boolean }> {
  return ctx.store.tx(async (t) => {
    await t.lockEnvironmentManifest(name);
    let made = 0;
    for (const n of (await t.environmentsOfManifest(name)).values()) made += n;
    if (made > 0)
      fail(409, `${made} Environment(s) were made from environment manifest ${name}: delete them first, or keep the manifest.`, {
        code: "manifest_in_use",
        details: { environments: made },
      });
    return { name, deleted: (await t.deleteEnvironmentManifest(name)) > 0 };
  });
}
