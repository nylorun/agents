/**
 * Sandboxes as a resource (blueprint D39, F7.1; Host feature `sandboxes`): `PUT`, `GET` and
 * `DELETE /v1/sandboxes/{id}`, the list by label, sessions attaching with `sandbox: { id }`, and
 * the checks every turn start makes on the sandbox its session is attached to.
 *
 * - **No scope.** The Runtime decides nothing about who shares a sandbox. It stores the
 *   sandbox's id, kind, spec and labels, and the session body names the sandbox it is attached
 *   to (`Session.sandboxId`); deleting a session (a sessions reset) only detaches it.
 * - **Access.** An application key reaches every sandbox, and so does an application key acting
 *   for a subject (`Nylorun-Subject`), which needs `sandboxes:write` to change one. A subject
 *   token reaches only the ids its `sbx` grants match, and changes them only with
 *   `sandboxes:write`; any other id is the 404 of a missing one.
 * - **Serial turns.** One turn at a time per sandbox: a session whose sandbox another attached
 *   session's turn holds is refused (`409 sandbox_busy`), as the session sandbox route is
 *   refused while its session's turn runs. Commands within the workspace keep queueing in the
 *   Sandbox Manager.
 * - **Kinds.** `virtual` only: its workspace is the virtual backend's, keyed by the sandbox id
 *   (`SandboxManager.sandboxKeyOf`) and created on the first tool call. `pod` is refused with
 *   `sandbox_unavailable` until sandbox pods arrive.
 * - **Lifecycle events** go to the sandbox's own stream in the record (`Tx.sandboxEvent`,
 *   `record/sandbox.ts`); the session's log records `sandbox.attached` too.
 */
import {
  sandboxGranted,
  type PutSandboxRequest,
  type SandboxView,
} from "@nylorun/core/contracts";
import type { SandboxManifest } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type { SandboxResource, Tx } from "../store/types.js";
import { resolveSandbox } from "../sandbox/resolve.js";
import {
  effectiveSandboxConfig,
  memoryMiB,
  readSandboxConfig,
} from "../sandbox/tenant-config.js";
import type { AuthScope, Session, TenantContext } from "./context.js";
import { fail } from "./http.js";

/** The `sbx` grants that limit `scope`, or undefined when it reaches every sandbox. */
export function sandboxGrantsOf(scope: AuthScope): readonly string[] | undefined {
  return scope.kind === "token" ? (scope.sandboxes ?? []) : undefined;
}

/** The subject whose sessions a sandbox's view lists, when the request acts for one. */
function ownerOf(scope: AuthScope): string | undefined {
  return scope.kind === "token" || scope.kind === "subject" ? scope.subject : undefined;
}

const notFound = (): never => fail(404, "Sandbox not found");

/** The sandbox, when `grants` reach it; otherwise the 404 of a missing one. */
function reachable(
  grants: readonly string[] | undefined,
  id: string,
): void {
  if (grants !== undefined && !sandboxGranted(grants, id)) notFound();
}

async function viewOf(
  ctx: TenantContext,
  t: Tx,
  sandbox: SandboxResource,
  owner: string | undefined,
): Promise<SandboxView> {
  const sessions = await t.sessionsOnSandbox<Session>(sandbox.id);
  const record = await t.get<{ state?: SandboxView["state"] }>(
    "sandboxes",
    ctx.sandbox.sandboxKeyOf(sandbox.id),
  );
  return {
    id: sandbox.id,
    kind: sandbox.kind,
    labels: sandbox.labels,
    spec: sandbox.spec as Record<string, unknown>,
    state: record?.state ?? "ready",
    sessions: sessions
      .filter((session) => owner === undefined || session.ownerUserId === owner)
      .map((session) => ({ id: session.id, activeTurnId: session.activeTurnId })),
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
  };
}

/** The spec a `PUT` asks for, resolved against the Tenant's limits. */
function resolveSpec(
  body: PutSandboxRequest,
  config: ReturnType<typeof effectiveSandboxConfig>,
): SandboxManifest {
  if (body.kind === "pod")
    fail(
      400,
      "This Runtime runs only virtual sandboxes: kind pod needs sandbox pods on a cluster, which it does not have.",
      { code: "sandbox_unavailable" },
    );
  const resolved = resolveSandbox({
    request: {
      ...(body.image === undefined ? {} : { image: body.image }),
      ...(body.network === undefined ? {} : { network: body.network }),
      ...(body.resources === undefined ? {} : { resources: body.resources }),
    },
    config,
    actingForSubject: false,
  });
  if (resolved.kind === "error") return fail(resolved.status, resolved.errors.join(" "));
  if (resolved.kind === "none") return fail(400, "The sandbox has no spec");
  return resolved.spec;
}

/**
 * Why an existing sandbox does not match what a `PUT` asks for, comparing only the fields the
 * request sends: an `ensure` that repeats its spec keeps working after the Tenant's defaults or
 * limits change.
 */
function specMismatch(existing: SandboxResource, body: PutSandboxRequest): string | undefined {
  if (body.kind !== undefined && body.kind !== existing.kind) return "kind";
  if (body.image !== undefined && body.image !== existing.spec.image) return "image";
  if (body.network !== undefined) {
    const asked = [...new Set((body.network.allow ?? []).map((host) => host.toLowerCase()))].sort();
    const has = [...(existing.spec.network?.allow ?? [])].sort();
    if (canonical(asked) !== canonical(has)) return "network";
  }
  const resources = existing.spec.resources;
  if (body.resources?.cpus !== undefined && body.resources.cpus !== resources?.cpus) return "resources";
  if (
    body.resources?.memory !== undefined &&
    (resources?.memory === undefined || memoryMiB(body.resources.memory) !== memoryMiB(resources.memory))
  )
    return "resources";
  return undefined;
}

/**
 * `PUT /v1/sandboxes/{id}`: creates the sandbox (within the Tenant's limit on their number), or
 * finds the one with this id, so "get or create" is one call. The spec is fixed once it exists;
 * labels, when sent, replace its labels.
 */
export async function putSandbox(
  ctx: TenantContext,
  id: string,
  body: PutSandboxRequest,
  scope: AuthScope,
): Promise<SandboxView> {
  const grants = sandboxGrantsOf(scope);
  reachable(grants, id);
  const conflict = (field: string): never =>
    fail(
      409,
      `Sandbox ${id} exists with another ${field}. Its spec is fixed: delete it to create it again.`,
    );
  return ctx.store.tx(async (t) => {
    const now = new Date().toISOString();
    const existing = await t.sandboxResource(id, { lock: true });
    if (existing) {
      const mismatch = specMismatch(existing, body);
      if (mismatch) conflict(mismatch);
      if (body.labels !== undefined && canonical(body.labels) !== canonical(existing.labels)) {
        await t.updateSandboxLabels(id, body.labels, now);
        return viewOf(ctx, t, { ...existing, labels: body.labels, updatedAt: now }, ownerOf(scope));
      }
      return viewOf(ctx, t, existing, ownerOf(scope));
    }
    const config = effectiveSandboxConfig(await readSandboxConfig(t));
    const spec = resolveSpec(body, config);
    const kind = body.kind ?? "virtual";
    const row: SandboxResource = {
      id,
      kind,
      spec,
      labels: body.labels ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const created = await t.createSandboxResource(row, config.limits.sandboxes);
    if (created === "limit")
      fail(409, `This Tenant allows at most ${config.limits.sandboxes} sandboxes.`, {
        code: "limit_exceeded",
        details: { limit: "sandboxes", max: config.limits.sandboxes },
      });
    if (created === "exists") {
      // Created by another request since the read above: answer as for an existing one.
      const found = (await t.sandboxResource(id, { lock: true })) ?? notFound();
      const mismatch = specMismatch(found, body);
      if (mismatch) conflict(mismatch);
      return viewOf(ctx, t, found, ownerOf(scope));
    }
    await t.sandboxEvent(id, "sandbox.created", { kind, labels: row.labels });
    return viewOf(ctx, t, row, ownerOf(scope));
  });
}

/** `GET /v1/sandboxes/{id}`. */
export async function getSandbox(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<SandboxView> {
  reachable(sandboxGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const sandbox = (await t.sandboxResource(id)) ?? notFound();
    return viewOf(ctx, t, sandbox, ownerOf(scope));
  });
}

/** `GET /v1/sandboxes?label=k=v`: every sandbox with all the labels, that the caller reaches. */
export async function listSandboxes(
  ctx: TenantContext,
  labels: Record<string, string>,
  scope: AuthScope,
): Promise<{ sandboxes: SandboxView[] }> {
  const grants = sandboxGrantsOf(scope);
  return ctx.store.tx(async (t) => {
    const found = await t.listSandboxResources({ labels });
    const views: SandboxView[] = [];
    for (const sandbox of found)
      if (grants === undefined || sandboxGranted(grants, sandbox.id))
        views.push(await viewOf(ctx, t, sandbox, ownerOf(scope)));
    return { sandboxes: views };
  });
}

/**
 * `DELETE /v1/sandboxes/{id}`: deletes the sandbox and its workspace. Refused while a session
 * attached to it has an active turn. Sessions stay attached by id: their next turn is refused
 * (`sandbox_unavailable`) unless a sandbox with this id exists again.
 */
export async function deleteSandbox(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<{ id: string; deleted: boolean }> {
  reachable(sandboxGrantsOf(scope), id);
  const deleted = await ctx.store.tx(async (t) => {
    const sandbox = await t.sandboxResource(id, { lock: true });
    if (!sandbox) return false;
    const busy = (await t.sessionsOnSandbox<Session>(id)).some(
      (session) => session.activeTurnId !== null,
    );
    if (busy)
      fail(409, `Sandbox ${id} has a turn running. Cancel it, or wait for it to end.`, {
        code: "sandbox_busy",
      });
    await t.sandboxEvent(id, "sandbox.deleted", {});
    await t.deleteSandboxResource(id);
    return true;
  });
  // After the commit: a turn that starts now finds no sandbox and is refused.
  if (deleted) await ctx.sandbox.removeSandbox(id);
  return { id, deleted };
}

/** `GET /v1/sandboxes/{id}/events`: the sandbox's lifecycle stream. */
export async function sandboxEventsOf(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
  fromSeq: number | undefined,
) {
  reachable(sandboxGrantsOf(scope), id);
  return ctx.store.tx(async (t) => ({
    events: await t.sandboxEvents(id, fromSeq === undefined ? {} : { fromSeq }),
  }));
}

/**
 * Attaches a new session to sandbox `id` (`PutSessionRequest.sandbox = { id }`): the sandbox
 * must exist and be reachable with `grants`. Returns its spec, which the session pins. Runs in
 * the session's transaction, after its session row lock.
 */
export async function attachSandbox(
  t: Tx,
  id: string,
  grants: readonly string[] | undefined,
): Promise<SandboxResource> {
  reachable(grants, id);
  return (await t.sandboxResource(id, { lock: true })) ?? notFound();
}

/** Records the attachment on the session's log and on the sandbox's stream. */
export async function recordAttachment(t: Tx, sessionId: string, sandboxId: string) {
  await t.event(sessionId, null, "sandbox.attached", { sandboxId });
  await t.sandboxEvent(sandboxId, "sandbox.attached", { sessionId });
}

/**
 * Checks a turn start on a session attached to a sandbox, in the command's transaction after
 * the session row lock: the sandbox still exists, a subject token's `sbx` grants reach it, and
 * no other session attached to it has a turn running. Holds the sandbox row's lock until the
 * transaction ends, so two turn starts on one sandbox are decided one after the other.
 */
export async function checkSandboxTurn(t: Tx, session: Session, scope: AuthScope): Promise<void> {
  const id = session.sandboxId;
  if (id === undefined) return;
  const grants = sandboxGrantsOf(scope);
  if (grants !== undefined && !sandboxGranted(grants, id))
    fail(403, `This token does not reach sandbox ${id}.`, { code: "sandbox_not_granted" });
  if (!(await t.sandboxResource(id, { lock: true })))
    fail(409, `Sandbox ${id} was deleted. Create it again to continue this session.`, {
      code: "sandbox_unavailable",
    });
  const holder = (await t.sessionsOnSandbox<Session>(id)).find(
    (other) => other.id !== session.id && other.activeTurnId !== null,
  );
  if (holder)
    fail(409, `Sandbox ${id} is running another session's turn. Turns are serial per sandbox.`, {
      code: "sandbox_busy",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
}

/** A sessions reset detaches every session from its sandbox: each sandbox's stream says so. */
export async function detachAllSessions(t: Tx): Promise<void> {
  for (const sandbox of await t.listSandboxResources()) {
    const sessions = await t.sessionsOnSandbox(sandbox.id);
    if (sessions.length === 0) continue;
    await t.sandboxResource(sandbox.id, { lock: true });
    for (const session of sessions)
      await t.sandboxEvent(sandbox.id, "sandbox.detached", {
        sessionId: session.id,
        reason: "reset",
      });
  }
}
