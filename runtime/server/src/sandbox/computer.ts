/**
 * Computers in core: a pod Agent on an Agent Substrate cluster whose sandboxes
 * service renders computers (`NYLORUN_SANDBOX_GATEWAY_URL` set). Its engine runs no loop: its
 * sessions' runs go to the harness container, and its commands and files go through the sandbox
 * gateway with a ticket core signs here (`computer-ticket.key`, Ed25519).
 *
 * - `computerAccess` wakes the computer when it isn't running (as a turn start does), waits until
 *   the sandboxes service says it is ready (its wake-up probe answered), records its first contact
 *   (`agent.running` or `agent.relaunched`, the pod's UID for the lost check), and answers where it
 *   is and a ticket. Core's own uses (the sandbox route, disk versions, artifacts) open it so.
 * - `openComputer` is what a harness gets with `computer.open`: the same, once a seed being copied
 *   onto a new volume is written, with the disk's setup run through the computer when
 *   its marker isn't the recipe's (`prepareComputerDisk`), and a version's start check
 *   passed.
 */
import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { TenantContext } from "../tenant/context.js";
import { fail, failRetryLater } from "../tenant/http.js";
import { wakePod } from "../tenant/agents.js";
import { passStartCheck } from "../tenant/agent-versions.js";
import { computerBackend, type ComputerAccess } from "../adapters/sandbox/computer.js";
import { SandboxManager } from "./manager.js";
import { memorySandboxRecords } from "./records.js";
import { recordSetup, setupFile, setupPlanOf, type SetupPlan, type SetupReport } from "./setup.js";
import type { SandboxHandle } from "./types.js";
import { hostTuning } from "../tuning.js";

/** How a Tenant reaches its computers. */
export interface TenantComputers {
  /** The sandbox gateway's base URL (`http://sandbox-gateway:4400`). */
  readonly gatewayUrl: string;
  /** The ticket key's private half. */
  readonly ticketKey: KeyObject;
  /** How long a ticket holds (10 minutes). */
  readonly ttlMs: number;
}

export const TICKET_TTL_MS = 10 * 60_000;

/** Reads `NYLORUN_COMPUTER_TICKET_KEY_FILE`'s key (PKCS #8 PEM, Ed25519). */
export function loadTicketKey(path: string): KeyObject {
  const key = createPrivateKey(readFileSync(path, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 key`);
  return key;
}

/** A computer ticket for sandbox `subject`, signed with `key`: a compact JWS (EdDSA). */
export function signTicket(key: KeyObject, subject: string, expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ aud: "nylorun-computer", sub: subject, exp: Math.floor(expiresAt / 1000) }),
  ).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${body}`), key).toString("base64url");
  return `${header}.${body}.${signature}`;
}

/** Whether pod Environments of this Tenant are computers. */
export function computersOf(ctx: Pick<TenantContext, "pods">): TenantComputers | undefined {
  return ctx.pods?.computer;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wakes computer `id` if needed, waits until it is ready, and answers where it is with a ticket.
 * Refused for a lost, deleted or failed one.
 */
export async function computerAccess(ctx: TenantContext, id: string, signal?: AbortSignal): Promise<ComputerAccess> {
  const computers = computersOf(ctx);
  const pods = ctx.pods;
  if (!computers || !pods) return fail(409, `Agent ${id} is not a computer on this Runtime.`, { code: "agent_unavailable" });
  const started = Date.now();
  // Whether it had to wake: it was not wanted running, or not running yet.
  const asleep = await wakePod(ctx, id);
  const deadline = Date.now() + hostTuning().pods.readyDeadlineMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
    const environment = await ctx.store.tx((t) => t.environment(id));
    const pod = environment?.pod;
    if (!environment || !pod || pod.desired === "deleted") return fail(404, `Agent ${id} does not exist.`, { code: "not_found" });
    if (pod.observed === "lost")
      return fail(409, `Agent ${id}'s computer was lost (${pod.reason ?? "its volume is gone"}). Reset it.`, { code: "agent_lost" });
    if (pod.observed === "failed")
      return fail(409, `Agent ${id}'s computer failed: ${pod.reason ?? "it did not start"}.`, { code: "agent_unavailable" });
    const status = await pods.client.status(pod.k8sName, { wait: "ready", timeoutMs: 20_000 }).catch(() => undefined);
    if (status?.ready && status.podUID) {
      // A drain the reconcile hasn't recorded yet (suspend before drain resumed it elsewhere,
      // ready at once): the reconcile records it, once.
      if (status.drainedAt !== undefined && status.drainedAt !== pod.drainedAt)
        await ctx.sandboxSignal(id, { kind: "reconcile" }).catch(() => undefined);
      await firstContact(ctx, id, status.podUID);
      if (asleep) ctx.config.logger.info("computer ready", { agentId: id, waitedMs: Date.now() - started });
      const expiresAt = Date.now() + computers.ttlMs;
      return {
        url: `${computers.gatewayUrl}/${pod.k8sName}`,
        ticket: signTicket(computers.ticketKey, pod.k8sName, expiresAt),
        expiresAt,
      };
    }
    if (Date.now() > deadline)
      failRetryLater(`Agent ${id}'s computer was not ready within ${hostTuning().pods.readyDeadlineMs / 1000} s.`, "agent_unavailable");
    // The reconcile moves the row along (creating → running); the next look waits on the service.
    await ctx.sandboxSignal(id, { kind: "reconcile" }).catch(() => undefined);
    await sleep(500);
  }
}

/** How long the disk's measure before an idle suspend may take. */
export const DISK_MEASURE_TIMEOUT_MS = 20_000;
/** What the measure runs on the computer: the size of what its disk keeps, in KiB. */
export const DISK_MEASURE_COMMAND = "du -sk /workspace /skills";

/**
 * The size of running computer `name`'s disk in bytes: `du` of `/workspace` and
 * `/skills` through the computer, within `DISK_MEASURE_TIMEOUT_MS`. Undefined when it could not
 * be measured: the caller goes on without it. It does not wake the computer: it asks only one
 * that runs.
 */
export async function computerDiskBytes(ctx: Pick<TenantContext, "pods">, name: string): Promise<number | undefined> {
  const computers = computersOf(ctx);
  if (!computers) return undefined;
  const expiresAt = Date.now() + computers.ttlMs;
  const access: ComputerAccess = {
    url: `${computers.gatewayUrl}/${name}`,
    ticket: signTicket(computers.ticketKey, name, expiresAt),
    expiresAt,
  };
  const signal = AbortSignal.timeout(DISK_MEASURE_TIMEOUT_MS + 5_000);
  try {
    const handle = await computerBackend({ open: async () => access, retryMs: 0 }).open({
      key: name,
      cpus: 1,
      memoryMiB: 1024,
      network: { preset: "none", hosts: [], suffixes: [] },
    });
    const result = await handle.exec({ command: DISK_MEASURE_COMMAND, cwd: "/", timeoutMs: DISK_MEASURE_TIMEOUT_MS }, signal);
    // A missing /skills fails du, but the sizes it printed stand.
    return diskBytesOf(result.stdout);
  } catch {
    return undefined;
  }
}

/** The bytes `du -sk` printed (one `<KiB>\t<path>` line per path), summed; undefined for none. */
export function diskBytesOf(stdout: string): number | undefined {
  let kib = 0;
  let found = false;
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\s+\S/.exec(line.trim());
    if (!match) continue;
    kib += Number(match[1]);
    found = true;
  }
  return found ? kib * 1024 : undefined;
}

/** Records the computer's first answer since it started: its UID, and `agent.running` or `agent.relaunched`. */
async function firstContact(ctx: TenantContext, id: string, podUid: string): Promise<void> {
  await ctx.store.tx(async (t) => {
    const environment = await t.environment(id, { lock: true });
    const pod = environment?.pod;
    if (!pod || pod.podUid === podUid || pod.desired !== "running") return;
    const now = new Date().toISOString();
    const epoch = pod.hostEpoch + 1;
    await t.updateEnvironmentPod(id, { podUid, hostEpoch: epoch, observed: "running", reason: null }, now);
    if (pod.podUid !== undefined) await t.agentEvent(id, "agent.relaunched", { hostEpoch: epoch });
    else await t.agentEvent(id, "agent.running", { hostEpoch: epoch });
  });
}

/**
 * The gateway's URL for computer `id`'s current incarnation, read from the store without waking
 * it: what `computer.current` answers a harness, and what core's own managers check a held access
 * against. A restore, a reset or a lost volume's recovery gives the Agent a new pod name, and so a
 * new URL. Refused for a deleted one.
 */
export async function currentComputerUrl(ctx: TenantContext, id: string): Promise<string> {
  const computers = computersOf(ctx);
  if (!computers) return fail(409, `Agent ${id} is not a computer on this Runtime.`, { code: "agent_unavailable" });
  const pod = (await ctx.store.tx((t) => t.environment(id)))?.pod;
  if (!pod || pod.desired === "deleted") return fail(404, `Agent ${id} does not exist.`, { code: "not_found" });
  return `${computers.gatewayUrl}/${pod.k8sName}`;
}

const opening = new Map<string, Promise<ComputerAccess>>();

/**
 * What `computer.open` answers a harness: access to computer `id`, once a seed is written, its
 * setup ran, and a version's start check passed. Concurrent opens of one computer share one.
 */
export function openComputer(ctx: TenantContext, id: string, signal?: AbortSignal): Promise<ComputerAccess> {
  const key = `${ctx.config.tenantId}\0${id}`;
  let pending = opening.get(key);
  if (!pending) {
    pending = openOnce(ctx, id, signal).finally(() => opening.delete(key));
    opening.set(key, pending);
  }
  return pending;
}

async function openOnce(ctx: TenantContext, id: string, signal?: AbortSignal): Promise<ComputerAccess> {
  let access = await computerAccess(ctx, id, signal);
  // A new volume being seeded from a disk version: wait until core has written it.
  const deadline = Date.now() + hostTuning().pods.readyDeadlineMs;
  for (;;) {
    const environment = await ctx.store.tx((t) => t.environment(id));
    if (!environment?.diskSeed || environment.diskSeed.written) break;
    const { runPendingSeed } = await import("../artifacts/disk.js");
    void runPendingSeed(ctx, id);
    if (Date.now() > deadline) failRetryLater(`Agent ${id}'s disk is still being copied.`, "agent_busy");
    await sleep(hostTuning().pods.enginePollMs);
  }
  const backend = computerBackend({ open: async () => (access = await computerAccess(ctx, id, signal)) });
  const handle = await backend.open({ key: id, cpus: 1, memoryMiB: 1024, network: { preset: "none", hosts: [], suffixes: [] } });
  await prepareComputerDisk(ctx, id, handle, signal);
  const environment = await ctx.store.tx((t) => t.environment(id));
  if (environment?.startCheck && environment.pod) await passStartCheck(ctx, id, environment.pod.hostEpoch);
  return access;
}

interface Marker {
  readonly volumeId: string;
  readonly recipeVersion: number;
  readonly setupHash?: string;
  readonly status: "ok";
}

const MARKER = "/harness/setup.json";
const VOLUME = "/harness/volume-id";

/** The disk's setup, run through the computer when its marker isn't the recipe's. */
export async function prepareComputerDisk(
  ctx: TenantContext,
  id: string,
  handle: SandboxHandle,
  signal?: AbortSignal,
): Promise<void> {
  const state = await ctx.store.tx(async (t) => {
    const environment = await t.environment(id);
    if (!environment?.pod) return undefined;
    return {
      epoch: environment.pod.hostEpoch,
      setup: await setupPlanOf(ctx, t, environment),
      seeded: environment.diskSeed !== undefined,
      afterSeed: environment.diskSeed?.setup === true,
    };
  });
  if (!state) return;
  let volumeId = (await handle.readFile(VOLUME))?.trim();
  if (!volumeId) {
    volumeId = randomUUID();
    await handle.writeFile(VOLUME, `${volumeId}\n`);
  }
  const markerOf = (setup: SetupPlan | undefined): Marker => ({
    volumeId: volumeId!,
    recipeVersion: setup?.recipeVersion ?? 0,
    ...(setup?.setupHash === undefined ? {} : { setupHash: setup.setupHash }),
    status: "ok",
  });
  const setup = state.setup;
  if (state.seeded && !state.afterSeed) {
    // The disk version holds what setup made: mark it done.
    await handle.writeFile(MARKER, `${JSON.stringify(markerOf(setup))}\n`);
    return;
  }
  if (!setup) {
    if (state.afterSeed) await recordSetup(ctx, id, state.epoch, { status: "ok" });
    return;
  }
  const raw = await handle.readFile(MARKER);
  if (raw) {
    try {
      const done = JSON.parse(raw) as Marker;
      const same = done.setupHash === undefined || done.setupHash === setup.setupHash;
      if (done.volumeId === volumeId && done.status === "ok" && same) return;
    } catch {
      // a broken marker: run it again
    }
  }
  ctx.config.logger.info("environment setup started", { environmentId: id, recipeVersion: setup.recipeVersion });
  const report = await runSetup(ctx, id, handle, setup, signal ?? new AbortController().signal);
  if (report.status === "ok") await handle.writeFile(MARKER, `${JSON.stringify(markerOf(setup))}\n`);
  await recordSetup(ctx, id, state.epoch, report);
  if (report.status === "failed")
    fail(409, `Agent ${id}'s setup failed${report.index === undefined ? "" : ` at command ${report.index + 1}`}: ${(report.output ?? "").slice(-500)}`, {
      code: "agent_unavailable",
    });
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function ensureDir(handle: SandboxHandle, path: string, signal: AbortSignal): Promise<void> {
  await handle.exec({ command: `mkdir -p '${path.replace(/'/g, "'\\''")}'`, cwd: "/", timeoutMs: 30_000 }, signal);
}

function under(base: string, relative: string): string {
  const joined = posix.normalize(posix.join(base, relative));
  if (joined !== base && !joined.startsWith(`${base.replace(/\/$/, "")}/`)) throw new Error(`${relative} would leave ${base}`);
  return joined;
}

async function runSetup(
  ctx: TenantContext,
  id: string,
  handle: SandboxHandle,
  setup: SetupPlan,
  signal: AbortSignal,
): Promise<SetupReport> {
  for (const file of setup.files) {
    try {
      const first = await setupFile(ctx, id, file.index, undefined);
      if (!first) throw new Error(`input file ${file.index + 1} is gone`);
      if (first.kind === "file") {
        await ensureDir(handle, posix.dirname(file.path), signal);
        await handle.writeFile(file.path, await bytesOf(first.body));
        continue;
      }
      for (const entry of first.entries) {
        const one = await setupFile(ctx, id, file.index, entry.path);
        if (!one || one.kind !== "file") throw new Error(`input file ${file.index + 1}, ${entry.path}, is gone`);
        const target = under(file.path, entry.path);
        await ensureDir(handle, posix.dirname(target), signal);
        await handle.writeFile(target, await bytesOf(one.body));
      }
    } catch (error) {
      return { status: "failed", output: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const [index, command] of setup.commands.entries()) {
    await ensureDir(handle, command.cwd, signal).catch(() => undefined);
    try {
      const result = await handle.exec(
        { command: command.command, cwd: command.cwd, timeoutMs: command.timeoutMs, env: setup.environment },
        signal,
      );
      if (result.exitCode !== 0) {
        const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}${result.timedOut ? "\n[timed out]" : ""}`;
        return { status: "failed", index, exitCode: result.exitCode, output: output.slice(-hostTuning().harness.setupReportTailChars) };
      }
    } catch (error) {
      return { status: "failed", index, output: error instanceof Error ? error.message : String(error) };
    }
  }
  return { status: "ok" };
}

/**
 * A SandboxManager per computer, for core's own uses: its backend opens the computer with
 * `computerAccess` (no setup run: the harness's `computer.open` does that before a turn's tools).
 */
export function computerManagers(
  ctx: () => TenantContext,
  emit: ConstructorParameters<typeof SandboxManager>[0]["emit"],
): (environmentId: string) => SandboxManager {
  const managers = new Map<string, SandboxManager>();
  return (environmentId) => {
    let manager = managers.get(environmentId);
    if (!manager) {
      manager = new SandboxManager({
        scope: ctx().config.tenantId,
        records: memorySandboxRecords(),
        backends: [
          computerBackend({
            open: (signal) => computerAccess(ctx(), environmentId, signal),
            // After a restore or a recovery the Agent is on a new computer: a disk copy onto its
            // new volume (or a command) must not reach the last one.
            isCurrent: async (access) =>
              access.url === (await currentComputerUrl(ctx(), environmentId).catch(() => undefined)),
          }),
        ],
        preference: "auto",
        ephemeral: false,
        emit,
      });
      managers.set(environmentId, manager);
    }
    return manager;
  };
}
