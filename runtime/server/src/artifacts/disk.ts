/**
 * An Environment's disk versions (R2d step 3, Host feature `environment-disk-versions`). A
 * version is a folder artifact version (manifest `nylorun.folder.v2`: files with mode and
 * modification time, links, empty directories) of the one folder artifact the Environment owns
 * (`artifacts.environment_id`), its files content-addressed in the Object store as every folder's
 * are: unchanged files are stored once.
 *
 * - **Snapshot** (`snapshotEnvironment`): between turns, under the disk lease (`disk_op`), core
 *   lists the disk through the workspace that holds it (a pod's engine, or the virtual workspace),
 *   reads each file in ranges, hashes every byte itself, stores what the Object store lacks and
 *   commits the version. An unchanged disk makes no version.
 * - **Seed** (`seedEnvironment`): empties the disk (the engine's own files stay) and writes a
 *   version back: directories, files (large ones in appended ranges), then links.
 * - **Restore** puts a version back: on a virtual Environment at once; on a pod as a reset whose
 *   new volume is seeded before any turn (`disk_seed`, run once the new pod's engine connects).
 *   **Fork** (`from` on a create, and `POST .../fork`) and the **recovery of a lost volume** (from
 *   the latest version) are seeds too. A fork onto other setup (Q17) keeps its seed, `written`,
 *   until the engine has run that setup on the written disk; turns wait for both.
 *
 * Nothing here runs inside a transaction but the lease and the commit. No event type is new:
 * a restore or recovery is `agent.reset` with `reason` and `from`.
 */
import { createHash, randomUUID } from "node:crypto";
import { newArtifactId } from "@nylorun/core/compatibility";
import {
  FOLDER_CONTENT_TYPE,
  FOLDER_MANIFEST_FORMAT_V2,
  type AgentRestore,
  type AgentSnapshot,
  type AgentDiskVersions,
  type FolderEntry,
} from "@nylorun/core/contracts";
import type { SandboxManifest } from "@nylorun/core/define";
import { sandboxSpecOf } from "../sandbox/resolve.js";
import type { DiskAnswer, DiskOp, DiskPut } from "../sandbox/disk-fs.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import type { SandboxSessionRef } from "../sandbox/manager.js";
import type { ArtifactRow, ArtifactVersionRow, DiskSeed, Environment, Tx } from "../store/types.js";
import type { TenantContext } from "../tenant/context.js";
import {
  assertReaches,
  diskHeld,
  liveEnvironment,
  newVolume,
  wakePod,
} from "../tenant/agents.js";
import { fail, failRetryLater } from "../tenant/http.js";
import { hostTuning } from "../tuning.js";
import { artifactQuota, totalSubject } from "./quota.js";
import { limitsInForce, readTenantLimits } from "../tenant/limits.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { collectContent, contentEpoch, contentKey, encodeManifest, readManifest, sha256Hex } from "./folders.js";
import { contentTypeFor } from "@nylorun/core/contracts";

/**
 * The Tenant's Runtime limits a copy reads when it starts (B15): `diskVersionEntries` and
 * `diskVersionBytes` (within the Environment's own `limits.disk`), `chunkBytes` (one range of a
 * file moved at a time, which crosses in one Harness API frame), `diskLeaseMs` (a lease lasts
 * this long unless renewed; a copy renews it every quarter of it) and `diskPodWaitMs` (how long a
 * copy waits for a pod's engine to connect).
 */
interface CopyLimits {
  readonly versionEntries: number;
  readonly versionBytes: number;
  readonly chunkBytes: number;
  readonly leaseMs: number;
  readonly podWaitMs: number;
}

async function copyLimits(ctx: TenantContext, environment?: Environment): Promise<CopyLimits> {
  return ctx.store.tx(async (t) => {
    const runtime = await readRuntimeLimits(t);
    const disk = limitsInForce(await readTenantLimits(t), environment?.applied.limits).disk;
    return {
      versionEntries: disk.versionEntries,
      versionBytes: disk.versionBytes,
      chunkBytes: runtime.chunkBytes,
      leaseMs: runtime.diskLeaseMs,
      podWaitMs: runtime.diskPodWaitMs,
    };
  });
}
/** The name of an Environment's disk artifact. */
export const DISK_ARTIFACT_NAME = "disk";

/** What the disk operations of Environment `environment` act through: a ref and its spec. */
async function diskTarget(
  ctx: TenantContext,
  environment: Environment,
): Promise<{ ref: SandboxSessionRef; spec: SandboxManifest }> {
  const config = effectiveSandboxConfig(await ctx.store.tx((t) => readSandboxConfig(t)));
  const spec = sandboxSpecOf(environment.applied, config.limits.idle);
  return {
    ref: {
      id: `disk:${environment.id}`,
      activeTurnId: null,
      environmentId: environment.id,
      // Not through a host a restore or a lost volume retired: its connection outlives the commit.
      ...(environment.pod === undefined ? {} : { hostEpoch: environment.pod.hostEpoch }),
    },
    spec,
  };
}

/** One disk operation through the workspace, or a `409 agent_unavailable`. */
async function diskOp(
  ctx: TenantContext,
  target: { ref: SandboxSessionRef; spec: SandboxManifest },
  op: DiskOp,
): Promise<DiskAnswer> {
  const answer = await ctx.sandbox.disk(target.ref, target.spec, op, new AbortController().signal);
  if ("code" in answer)
    return fail(409, `The disk could not be reached: ${answer.message}`, { code: "agent_unavailable" });
  return answer;
}

/**
 * Takes the disk lease of Environment `id` for `kind`: refused (`409 agent_busy`) while a
 * turn runs or another copy holds it; `400` for kind `none`, which has no disk.
 */
async function lease(
  ctx: TenantContext,
  id: string,
  kind: "snapshot" | "restore" | "seed",
  leaseMs: number,
  version?: number,
): Promise<Environment> {
  return ctx.store.tx(async (t) => {
    const environment = (await liveEnvironment(t, id, { lock: true })) ?? fail(404, "Agent not found");
    if (environment.kind === "none") fail(400, `Agent ${id} is of kind none: it has no disk.`);
    const busy = (await t.sessionsOnEnvironment(id)).some((session) => (session as { activeTurnId?: string | null }).activeTurnId);
    if (busy || diskHeld(environment))
      failRetryLater(`Agent ${id} has a turn running or its disk is being copied. Try again shortly.`, "agent_busy");
    const now = new Date();
    const operation = {
      kind,
      ...(version === undefined ? {} : { version }),
      startedAt: now.toISOString(),
      until: new Date(now.getTime() + leaseMs).toISOString(),
    };
    await t.updateEnvironment(id, { diskOp: operation }, now.toISOString());
    return { ...environment, diskOp: operation };
  });
}

/**
 * Renews the lease for `ms` more every quarter of `limits.leaseMs` until `stop()`, which ends it
 * (and, with `seed`, the seed).
 */
function heartbeat(ctx: TenantContext, id: string, limits: CopyLimits, ms = limits.leaseMs) {
  const timer = setInterval(() => {
    void ctx.store
      .tx(async (t) => {
        const environment = await t.environment(id, { lock: true });
        if (!environment?.diskOp) return;
        const now = new Date();
        await t.updateEnvironment(
          id,
          { diskOp: { ...environment.diskOp, until: new Date(now.getTime() + ms).toISOString() } },
          now.toISOString(),
        );
      })
      .catch(() => undefined);
  }, limits.leaseMs / 4);
  timer.unref();
  return {
    async stop(options: { seed?: DiskSeed } = {}) {
      clearInterval(timer);
      await ctx.store.tx(async (t) => {
        const environment = await t.environment(id, { lock: true });
        if (!environment) return;
        const seed = environment.diskSeed;
        const written =
          options.seed !== undefined &&
          seed?.artifactId === options.seed.artifactId &&
          seed.version === options.seed.version;
        // A seed with setup stays, written, until the engine reports the setup done (Q17).
        const next = !written ? {} : seed.setup ? { diskSeed: { ...seed, written: true as const } } : { diskSeed: null };
        await t.updateEnvironment(id, { diskOp: null, ...next }, new Date().toISOString());
      });
    },
  };
}

/** Waits until the engine of pod Environment `id` is connected, starting the pod when it is stopped. */
async function awaitEngine(ctx: TenantContext, id: string, waitMs: number): Promise<void> {
  await wakePod(ctx, id);
  const deadline = Date.now() + waitMs;
  while (!ctx.harness.hosting(id)) {
    if (Date.now() > deadline)
      failRetryLater(`Agent ${id}'s pod did not start within ${waitMs / 1000} s (the Runtime limit diskPodWaitMs).`, "agent_unavailable");
    await new Promise((resolve) => setTimeout(resolve, hostTuning().pods.enginePollMs));
  }
}

/** A file's bytes and their hash, read in ranges. */
async function readFile(
  ctx: TenantContext,
  target: { ref: SandboxSessionRef; spec: SandboxManifest },
  path: string,
  rangeBytes: number,
): Promise<{ bytes: Uint8Array; sha256: string } | undefined> {
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const answer = await diskOp(ctx, target, { read: { path, offset, length: rangeBytes } });
    if (answer.kind === "missing") return undefined;
    if (answer.kind !== "read") throw new Error(`Unexpected answer reading ${path}`);
    hash.update(answer.bytes);
    chunks.push(answer.bytes);
    offset += answer.bytes.length;
    if (answer.eof || answer.bytes.length === 0) break;
  }
  return { bytes: Buffer.concat(chunks), sha256: hash.digest("hex") };
}

/**
 * `POST /v1/agents/{id}/snapshot`: a new version of the Environment's disk, between turns.
 * A pod that is stopped is started first. An unchanged disk makes no version.
 */
export async function snapshotEnvironment(ctx: TenantContext, id: string, scope: Parameters<typeof assertReaches>[0]): Promise<AgentSnapshot> {
  assertReaches(scope, id);
  const started = Date.now();
  const limits = await copyLimits(ctx, await ctx.store.tx((t) => liveEnvironment(t, id)));
  const environment = await lease(ctx, id, "snapshot", limits.leaseMs);
  const beat = heartbeat(ctx, id, limits);
  try {
    if (environment.kind === "pod") await awaitEngine(ctx, id, limits.podWaitMs);
    const target = await diskTarget(ctx, environment);
    const listed = await diskOp(ctx, target, { list: { maxEntries: limits.versionEntries } });
    if (listed.kind !== "listed") throw new Error("The disk was not listed");
    if (listed.truncated)
      fail(413, `The disk holds more than ${limits.versionEntries} entries (the limit diskVersionEntries).`, {
        code: "limit_exceeded",
        details: { limit: "files", max: limits.versionEntries },
      });
    const bytes = listed.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0);
    if (bytes > limits.versionBytes)
      fail(413, `The disk holds ${bytes} bytes; a version holds at most ${limits.versionBytes} (the limit diskVersionBytes).`, {
        code: "limit_exceeded",
        details: { limit: "bytes", max: limits.versionBytes },
      });
    const epoch = await ctx.store.tx((t) => contentEpoch(t));
    const entries: FolderEntry[] = [];
    let storedBytes = 0;
    for (const entry of listed.entries) {
      // A directory keeps its mode and a link its target: their times change when written back,
      // so only files keep theirs (and an unchanged disk makes the same manifest).
      if (entry.type === "dir") {
        entries.push({ path: entry.path, mode: entry.mode, size: 0, sha256: "", contentType: "", type: "dir" });
        continue;
      }
      if (entry.type === "link") {
        entries.push({ path: entry.path, size: 0, sha256: "", contentType: "", type: "link", target: entry.target ?? "" });
        continue;
      }
      const base = { path: entry.path, mode: entry.mode, mtimeMs: entry.mtimeMs };
      const read = await readFile(ctx, target, entry.path, limits.chunkBytes);
      if (!read) continue; // removed while it was copied (a background process)
      const key = contentKey(read.sha256);
      if (!(await ctx.blobs.head(key))) {
        await ctx.blobs.put(key, read.bytes, { contentType: "application/octet-stream" });
        storedBytes += read.bytes.length;
      }
      entries.push({
        ...base,
        size: read.bytes.length,
        sha256: read.sha256,
        contentType: contentTypeFor(entry.path),
      });
    }
    const committed = await commitDiskVersion(ctx, id, entries, epoch);
    ctx.config.logger.info("disk_snapshot", {
      environmentId: id,
      version: committed.version.version,
      files: entries.length,
      bytes,
      storedBytes,
      unchanged: committed.unchanged,
      durationMs: Date.now() - started,
    });
    return {
      agentId: id,
      artifactId: committed.artifact.id,
      version: committed.version.version,
      format: FOLDER_MANIFEST_FORMAT_V2,
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      storedBytes: committed.unchanged ? 0 : storedBytes,
      durationMs: Date.now() - started,
      unchanged: committed.unchanged,
      createdAt: committed.version.createdAt,
    };
  } finally {
    await beat.stop();
  }
}

/**
 * Commits a disk version whose files are stored: its manifest to the Object store, then under
 * the Environment's row, the quota and the artifact (that lock order) the version and its
 * content rows, within the Tenant total. No version when the manifest is the latest one's.
 */
async function commitDiskVersion(
  ctx: TenantContext,
  id: string,
  entries: FolderEntry[],
  epoch: number,
): Promise<{ artifact: ArtifactRow; version: ArtifactVersionRow; unchanged: boolean }> {
  const manifest = encodeManifest(entries, FOLDER_MANIFEST_FORMAT_V2);
  const sha256 = sha256Hex(manifest);
  const files = new Map<string, number>();
  for (const entry of entries) if (entry.type === undefined) files.set(entry.sha256, entry.size);
  const size = [...files.values()].reduce((sum, value) => sum + value, 0);
  const prior = await ctx.store.tx((t) => t.diskArtifact(id));
  if (prior && prior.latestVersion > 0) {
    const latest = await ctx.store.tx((t) => t.artifactVersion(prior.id, prior.latestVersion));
    if (latest && latest.sha256 === sha256) return { artifact: prior, version: latest, unchanged: true };
  }
  const artifactId = prior?.id ?? newArtifactId();
  const key = `artifacts/${artifactId}/${randomUUID()}`;
  await ctx.blobs.put(key, manifest, { contentType: FOLDER_CONTENT_TYPE });
  return ctx.store.tx(async (t) => {
    (await liveEnvironment(t, id, { lock: true })) ?? fail(404, "Agent not found");
    const quota = await artifactQuota(t, id);
    await t.lockArtifactQuota();
    const shas = [...files.keys()];
    const referenced = await t.referencedArtifactContent(shas);
    const fresh = shas.filter((sha) => !referenced.has(sha));
    if ((await contentEpoch(t)) !== epoch)
      for (const sha of fresh)
        if (!(await ctx.blobs.head(contentKey(sha))))
          fail(409, "A file's bytes were removed while the snapshot ran; try again.", { code: "agent_busy" });
    for (const total of quota.totals) {
      // A file adds bytes to a total unless an artifact it counts already holds the file.
      const scope = total.environmentId === undefined ? undefined : { environmentId: total.environmentId };
      const held = scope === undefined ? referenced : await t.referencedArtifactContent(shas, scope);
      const added = shas.filter((sha) => !held.has(sha)).reduce((sum, sha) => sum + files.get(sha)!, 0);
      const used = await t.artifactBytes(scope);
      if (used + added > total.limitBytes)
        fail(413, `${totalSubject(total)} may hold at most ${total.limitBytes} bytes; this version adds ${added} to ${used}.`, {
          code: "limit_exceeded",
          details: { limit: scope === undefined ? "tenant_total" : "environment_total", max: total.limitBytes },
        });
    }
    const createdAt = new Date().toISOString();
    const current = await t.diskArtifact(id, { lock: true });
    const version: ArtifactVersionRow = {
      artifactId,
      version: (current?.latestVersion ?? 0) + 1,
      blobKey: key,
      size,
      sha256,
      contentType: FOLDER_CONTENT_TYPE,
      source: "snapshot",
      createdAt,
      writeKey: null,
    };
    let artifact: ArtifactRow;
    if (current) {
      await t.insertArtifactVersion(version);
      artifact = { ...current, latestVersion: version.version, updatedAt: createdAt };
    } else {
      artifact = {
        id: artifactId,
        kind: "folder",
        name: DISK_ARTIFACT_NAME,
        contentType: FOLDER_CONTENT_TYPE,
        sessionId: null,
        latestVersion: 1,
        labelsJson: null,
        createdAt,
        updatedAt: createdAt,
        environmentId: id,
      };
      await t.insertArtifact(artifact, version);
    }
    await t.insertArtifactContent(
      artifactId,
      version.version,
      shas.map((sha) => ({ sha256: sha, size: files.get(sha)! })),
    );
    return { artifact, version, unchanged: false };
  });
}

/**
 * Writes disk version `seed` into Environment `id`'s workspace: empties it (the engine's files
 * stay), then directories, files (large ones in ranges) and links. Its caller holds the lease.
 */
async function writeVersion(
  ctx: TenantContext,
  environment: Environment,
  seed: { artifactId: string; version: number },
  rangeBytes: number,
): Promise<{ files: number; bytes: number }> {
  const version = await ctx.store.tx((t) => t.artifactVersion(seed.artifactId, seed.version));
  if (!version) throw new Error(`Disk version ${seed.version} of ${seed.artifactId} is gone`);
  const manifest = await readManifest(ctx.blobs, version);
  const target = await diskTarget(ctx, environment);
  await diskOp(ctx, target, { clear: true });
  const dirs = manifest.entries.filter((entry) => entry.type === "dir");
  const links = manifest.entries.filter((entry) => entry.type === "link");
  const files = manifest.entries.filter((entry) => entry.type === undefined);
  if (dirs.length > 0)
    await diskOp(ctx, target, {
      put: dirs.map((entry) => ({ path: entry.path, type: "dir", ...(entry.mode === undefined ? {} : { mode: entry.mode }) })),
    });
  let batch: DiskPut[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await diskOp(ctx, target, { put: batch });
    batch = [];
    batchBytes = 0;
  };
  let bytes = 0;
  for (const entry of files) {
    const got = await ctx.blobs.get(contentKey(entry.sha256));
    if (!got) throw new Error(`The bytes of ${entry.path} are missing from the Object store`);
    const content = new Uint8Array(await new Response(got.body).arrayBuffer());
    bytes += content.length;
    const meta = {
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
    };
    if (content.length <= rangeBytes) {
      if (batchBytes + content.length > rangeBytes) await flush();
      batch.push({ path: entry.path, type: "file", bytes: content, ...meta });
      batchBytes += content.length;
      continue;
    }
    await flush();
    for (let offset = 0; offset < content.length; offset += rangeBytes) {
      const last = offset + rangeBytes >= content.length;
      await diskOp(ctx, target, {
        put: [
          {
            path: entry.path,
            type: "file",
            bytes: content.subarray(offset, offset + rangeBytes),
            ...(offset > 0 ? { append: true } : {}),
            ...(last ? meta : {}),
          },
        ],
      });
    }
  }
  await flush();
  if (links.length > 0)
    await diskOp(ctx, target, {
      put: links.map((entry) => ({ path: entry.path, type: "link", target: entry.target ?? "" })),
    });
  return { files: manifest.entries.length, bytes };
}

/** The version `version` names of Environment `id`'s disk, or the 404 of a missing one. */
async function versionOf(t: Tx, id: string, version: number | "latest"): Promise<{ artifactId: string; version: number }> {
  const artifact = await t.diskArtifact(id);
  const number = version === "latest" ? artifact?.latestVersion : version;
  if (!artifact || !number || !(await t.artifactVersion(artifact.id, number)))
    return fail(404, `Agent ${id} has no disk version ${version}`);
  return { artifactId: artifact.id, version: number };
}

/**
 * `POST /v1/agents/{id}/restore`: puts disk version `version` back. A virtual
 * Environment's workspace is rewritten at once; a pod gets a new volume, seeded from the version
 * before any turn (`status: pending` until then).
 */
export async function restoreEnvironment(
  ctx: TenantContext,
  id: string,
  scope: Parameters<typeof assertReaches>[0],
  version: number | "latest",
): Promise<AgentRestore> {
  assertReaches(scope, id);
  const seed = await ctx.store.tx((t) => versionOf(t, id, version));
  const found = await ctx.store.tx((t) => liveEnvironment(t, id));
  if (!found) return fail(404, "Agent not found");
  if (found.kind === "pod") {
    const volumeGeneration = await ctx.store.tx(async (t) => {
      const environment = (await liveEnvironment(t, id, { lock: true })) ?? fail(404, "Agent not found");
      const busy = (await t.sessionsOnEnvironment(id)).some((session) => (session as { activeTurnId?: string | null }).activeTurnId);
      if (busy || diskHeld(environment) || environment.pod!.retiring !== undefined)
        failRetryLater(`Agent ${id} has a turn running, its disk is being copied or its last volume is still being deleted.`, "agent_busy");
      return newVolume(ctx, t, environment, { seed, reason: "restore" });
    });
    return { agentId: id, restored: seed.version, status: "pending", volumeGeneration };
  }
  const limits = await copyLimits(ctx, found);
  const environment = await lease(ctx, id, "restore", limits.leaseMs, seed.version);
  const beat = heartbeat(ctx, id, limits);
  try {
    await writeVersion(ctx, environment, seed, limits.chunkBytes);
  } finally {
    await beat.stop();
  }
  return { agentId: id, restored: seed.version, status: "done" };
}

/** Seeds that run in this process, so the sweep starts no second copy. */
const running = new Set<string>();

/**
 * Writes Environment `id`'s pending seed (`disk_seed`) into its disk, once its pod's engine is
 * connected (or at once for a virtual one), then clears the seed and the lease. Started after a
 * pod joins, after a virtual Environment is forked, and by the Tenant sweep for a seed whose
 * lease lapsed. Best effort: a failure leaves the seed for the next try.
 */
export async function runPendingSeed(ctx: TenantContext, id: string): Promise<void> {
  const key = `${ctx.config.tenantId}\0${id}`;
  if (running.has(key)) return;
  running.add(key);
  try {
    const environment = await ctx.store.tx((t) => liveEnvironment(t, id));
    const seed = environment?.diskSeed;
    if (!environment || !seed || seed.written) return;
    const limits = await copyLimits(ctx, environment);
    if (environment.kind === "pod") {
      const deadline = Date.now() + limits.podWaitMs;
      // The engine on the new volume: the old one's connection may still be open.
      while (!ctx.harness.hosting(id, environment.pod?.hostEpoch)) {
        if (Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, hostTuning().pods.enginePollMs));
      }
    }
    const beat = heartbeat(ctx, id, limits, hostTuning().tenant.seedLeaseMs);
    let done = false;
    try {
      const started = Date.now();
      const written = await writeVersion(ctx, environment, seed, limits.chunkBytes);
      done = true;
      ctx.config.logger.info("disk_seed", { environmentId: id, version: seed.version, ...written, durationMs: Date.now() - started });
    } finally {
      await beat.stop(done ? { seed } : {});
    }
  } catch (error) {
    ctx.config.logger.warn("disk_seed_failed", {
      environmentId: id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running.delete(key);
  }
}

/** Starts the pending seeds whose engine is connected and whose lease lapsed (Tenant sweep). */
export async function sweepPendingSeeds(ctx: TenantContext): Promise<void> {
  const pending = (await ctx.store.tx((t) => t.listEnvironments())).filter(
    (environment) =>
      environment.diskSeed !== undefined && !environment.diskSeed.written && environment.pod?.desired !== "deleted",
  );
  for (const environment of pending)
    if (environment.kind !== "pod" || ctx.harness.hosting(environment.id, environment.pod?.hostEpoch))
      void runPendingSeed(ctx, environment.id);
}

/**
 * After a pod Environment was found `lost`: when its disk has a version, it gets a new volume
 * seeded from the latest one, instead of refusing turns until a reset (R6 Q9: eager).
 */
export async function recoverLostVolume(ctx: TenantContext, id: string): Promise<boolean> {
  const recovered = await ctx.store.tx(async (t) => {
    const environment = await liveEnvironment(t, id, { lock: true });
    if (!environment?.pod || environment.pod.observed !== "lost" || environment.pod.retiring !== undefined) return undefined;
    const artifact = await t.diskArtifact(id);
    if (!artifact || artifact.latestVersion < 1) return undefined;
    const seed = { artifactId: artifact.id, version: artifact.latestVersion };
    await newVolume(ctx, t, environment, { seed, reason: "lost" });
    return seed;
  });
  if (recovered)
    ctx.config.logger.warn("environment volume lost: recovered from the latest disk version", {
      environmentId: id,
      version: recovered.version,
    });
  return recovered !== undefined;
}

/** The disk version a fork starts from (`from` on a create), after the caller's checks. */
export async function forkSeedOf(
  t: Tx,
  from: { environment: string; version: number | "latest" },
): Promise<{ artifactId: string; version: number }> {
  return versionOf(t, from.environment, from.version);
}

/** `GET /v1/agents/{id}/versions`: its disk versions, newest first. */
export async function environmentVersions(
  ctx: TenantContext,
  id: string,
  scope: Parameters<typeof assertReaches>[0],
): Promise<AgentDiskVersions> {
  assertReaches(scope, id);
  return ctx.store.tx(async (t) => {
    (await liveEnvironment(t, id)) ?? fail(404, "Agent not found");
    const artifact = await t.diskArtifact(id);
    const versions = artifact ? await t.artifactVersions(artifact.id) : [];
    return {
      agentId: id,
      artifactId: artifact?.id ?? null,
      latest: artifact && artifact.latestVersion > 0 ? artifact.latestVersion : null,
      versions: versions
        .map((row) => ({ version: row.version, bytes: row.size, createdAt: row.createdAt }))
        .reverse(),
    };
  });
}

/**
 * `DELETE /v1/agents/{id}/versions/{n}`: deletes one disk version, and the stored files no
 * other version names. Refused while a seed reads it.
 */
export async function deleteEnvironmentVersion(
  ctx: TenantContext,
  id: string,
  scope: Parameters<typeof assertReaches>[0],
  version: number,
): Promise<{ agentId: string; version: number; deleted: boolean }> {
  assertReaches(scope, id);
  const blobKey = await ctx.store.tx(async (t) => {
    const environment = (await liveEnvironment(t, id, { lock: true })) ?? fail(404, "Agent not found");
    const artifact = await t.diskArtifact(id, { lock: true });
    if (!artifact) return undefined;
    if (environment.diskSeed?.artifactId === artifact.id && environment.diskSeed.version === version)
      failRetryLater(`A new volume of Agent ${id} is being seeded from version ${version}.`, "agent_busy");
    await t.lockArtifactQuota();
    const content = await t.artifactContentShas({ artifactId: artifact.id });
    const key = await t.deleteArtifactVersion(artifact.id, version);
    if (key !== undefined) await collectContent(ctx.blobs, t, content);
    return key;
  });
  if (blobKey !== undefined) await ctx.blobs.delete(blobKey).catch(() => undefined);
  return { agentId: id, version, deleted: blobKey !== undefined };
}

/**
 * Deletes Environment `id`'s disk artifact with its versions, in the transaction that deletes the
 * Environment (it holds the row's lock); returns the manifests' keys to delete after commit.
 */
export async function deleteDiskArtifact(ctx: TenantContext, t: Tx, id: string): Promise<string[]> {
  const artifact = await t.diskArtifact(id);
  if (!artifact) return [];
  await t.lockArtifactQuota();
  const content = await t.artifactContentShas({ artifactId: artifact.id });
  const keys = await t.deleteArtifact(artifact.id);
  await collectContent(ctx.blobs, t, content);
  return keys;
}
