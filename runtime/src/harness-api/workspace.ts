/**
 * The workspace capability (F6.2): what core does with the Tenant's sandbox workspaces outside a
 * run. `ctx.sandbox` is a `WorkspacePort`: the sandbox tool routes (`POST
 * /v1/sessions/:id/sandbox/:tool` and an Action endpoint's `POST /v1/actions/:id/sandbox/:tool`),
 * Tenant status, the Tenant sweep, a sandbox resource's deletion and a sandboxes reset.
 *
 * - **In process** (`localWorkspace`): the Tenant's own SandboxManager, which its in-process
 *   harness also runs sandbox tools with.
 * - **Remote** (`remoteWorkspace`): the harness that declared `workspace` in its `hello` holds
 *   the workspaces. `bash` becomes `workspace.exec`, `read`/`grep`/`glob` `workspace.read`,
 *   `write`/`edit` `workspace.write`; a request is aborted when its HTTP client leaves. With no
 *   such harness connected a tool call is `503 request_rejected`. The sweep asks the harness to
 *   stop idle workspaces and list them (`workspace.sweep`), decides which owners are gone, and
 *   removes theirs (`workspace.remove`); it also keeps the `sandboxes` table in step with the
 *   list.
 * - **Pod sandboxes** (F7.2, `withPodWorkspaces`): a session attached to a pod sandbox has its
 *   workspace in the pod, served by the sandbox's engine (its host connection). Its tool calls,
 *   listings and reads go there whatever serves the other workspaces; with the pod stopped or
 *   starting they are `409 sandbox_unavailable`.
 */
import { HarnessApiError, type CoreMethod, type WorkspaceRecord } from "@nylorun/core/harness-api";
import type { CapabilityManifest, SandboxToolName } from "@nylorun/core/define";
import type { SandboxManager, SandboxSessionRef } from "../sandbox/manager.js";
import { DEFAULT_SANDBOX_IMAGE } from "../sandbox/policy.js";
import type { SandboxSelectionReport } from "../sandbox/select.js";
import type { SandboxToolOutcome } from "../sandbox/tools.js";
import type { SessionStore } from "../store/types.js";
import { fail } from "../tenant/http.js";
import type { Logger } from "../tenant/types.js";
import { NoWorkspaceHarness, type HarnessApiServer } from "./server.js";

/** The sandbox selection, as `GET /v1/tenant/sandbox` and Tenant status report it. */
export type WorkspaceReport = SandboxSelectionReport & { readonly defaultImage: string };

type Exists = (id: string) => boolean | Promise<boolean>;

export interface WorkspacePort {
  /** Runs one sandbox tool in the workspace of `session`. */
  run(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    toolName: SandboxToolName,
    input: unknown,
    signal: AbortSignal
  ): Promise<SandboxToolOutcome>;
  /** Lists the files under `dir` of the workspace of `session` (the turn-end export, F8.2). */
  listFiles(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    dir: string,
    maxEntries: number,
    signal: AbortSignal
  ): ReturnType<SandboxManager["listFiles"]>;
  /** Reads a file of the workspace of `session` as bytes, at most `maxBytes` (`save_artifact`). */
  readBytes(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    path: string,
    maxBytes: number,
    signal: AbortSignal
  ): ReturnType<SandboxManager["readBytes"]>;
  report(): Promise<WorkspaceReport>;
  /** One Tenant sweep pass: stop idle workspaces, remove those whose owner is gone. */
  sweep(options: { now?: number; sessionExists: Exists; sandboxExists: Exists }): Promise<void>;
  /** Deletes sandbox resource `sandboxId`'s workspace (the resource was deleted). */
  removeSandbox(sandboxId: string): Promise<void>;
  /** Deletes every workspace with its files (a sandboxes reset). */
  removeAll(): Promise<void>;
  close(): Promise<void>;
}

/** The Tenant's own SandboxManager. */
export function localWorkspace(manager: SandboxManager): WorkspacePort {
  return {
    run: (session, capability, toolName, input, signal) =>
      manager.run(session, capability, toolName, input, signal),
    listFiles: (session, capability, dir, maxEntries, signal) =>
      manager.listFiles(session, capability, dir, maxEntries, signal),
    readBytes: (session, capability, path, maxBytes, signal) =>
      manager.readBytes(session, capability, path, maxBytes, signal),
    report: () => manager.report(),
    sweep: (options) => manager.sweep(options),
    removeSandbox: (sandboxId) => manager.removeSandbox(sandboxId),
    removeAll: () => manager.reconcile(() => false, () => false),
    close: () => manager.close(),
  };
}

const METHODS: Readonly<Record<SandboxToolName, CoreMethod>> = {
  bash: "workspace.exec",
  read: "workspace.read",
  grep: "workspace.read",
  glob: "workspace.read",
  write: "workspace.write",
  edit: "workspace.write",
};

export interface RemoteWorkspaceOptions {
  readonly server: HarnessApiServer;
  readonly store: SessionStore;
  readonly logger: Logger;
  /** The sandbox backend preference, reported while no harness serves workspaces. */
  readonly preference: string;
  /** The pod sandbox whose host serves these workspaces (F7.2). */
  readonly pod?: string;
}

function sessionOf(session: SandboxSessionRef) {
  return {
    ownerId: session.id,
    ...(session.sandboxId === undefined ? {} : { sandboxId: session.sandboxId }),
    activeTurnId: session.activeTurnId,
  };
}

/** The workspaces of the harness that serves them. */
export function remoteWorkspace(options: RemoteWorkspaceOptions): WorkspacePort {
  const { store } = options;
  const target = options.pod === undefined ? undefined : { pod: options.pod };
  const unavailable = (error: NoWorkspaceHarness): never =>
    error.pod === undefined
      ? fail(503, error.message, { code: "request_rejected" })
      : fail(409, error.message, { code: "sandbox_unavailable" });
  /** The harness's answer, or `undefined` when none serves workspaces. */
  const ask = async <M extends CoreMethod>(
    method: M,
    params: Parameters<HarnessApiServer["workspace"]>[1] & object,
    signal?: AbortSignal
  ) => {
    try {
      return await options.server.workspace(method, params as never, signal);
    } catch (error) {
      if (error instanceof NoWorkspaceHarness) return undefined;
      throw error;
    }
  };
  const sweep = async (sessionExists: Exists, sandboxExists: Exists, now?: number) => {
    const answer = await ask("workspace.sweep", now === undefined ? {} : { now });
    if (!answer) return;
    const { workspaces } = answer as { workspaces: WorkspaceRecord[] };
    const gone: string[] = [];
    for (const record of workspaces) {
      const kept =
        record.sandboxId === undefined
          ? await sessionExists(record.sessionId)
          : await sandboxExists(record.sandboxId);
      if (!kept) gone.push(record.key);
    }
    if (gone.length > 0) await ask("workspace.remove", { keys: gone });
    // The `sandboxes` table follows the harness: what it no longer runs is stopped, what it
    // removed is gone.
    const listed = new Map(workspaces.map((record) => [record.key, record]));
    await store.tx(async (t) => {
      for (const row of await t.listSandboxes<WorkspaceRecord>()) {
        const record = listed.get(row.key);
        if (!record || gone.includes(row.key)) await t.delete("sandboxes", row.key);
        else if (record.state !== row.state) await t.put("sandboxes", row.key, { ...row, state: record.state });
      }
    });
  };
  return {
    async run(session, capability, toolName, input, signal) {
      try {
        return (await options.server.workspace(
          METHODS[toolName],
          {
            session: sessionOf(session),
            spec: capability.sandbox ?? {},
            tool: toolName,
            input: input ?? {},
          },
          signal,
          target
        )) as unknown as SandboxToolOutcome;
      } catch (error) {
        if (error instanceof NoWorkspaceHarness) return unavailable(error);
        if (error instanceof HarnessApiError && error.code === "unavailable" && !signal.aborted)
          return fail(503, `The harness serving workspaces went away: ${error.message}`, {
            code: "request_rejected",
          });
        throw error;
      }
    },
    async listFiles(session, capability, dir, maxEntries, signal) {
      try {
        const answer = (await options.server.workspace(
          "workspace.read",
          { session: sessionOf(session), spec: capability.sandbox ?? {}, list: { dir, maxEntries } },
          signal,
          target
        )) as { kind: string; path?: string; listing?: unknown; code?: string; message?: string };
        if (answer.kind === "listed")
          return {
            kind: "listed",
            path: String(answer.path),
            listing: answer.listing as Extract<Awaited<ReturnType<SandboxManager["listFiles"]>>, { kind: "listed" }>["listing"],
          };
        if (answer.kind === "missing") return { kind: "missing", path: String(answer.path) };
        return { kind: "failed", code: String(answer.code), message: String(answer.message) };
      } catch (error) {
        // No harness holds the workspaces: there is nothing to export.
        if (error instanceof NoWorkspaceHarness) return { kind: "missing", path: dir };
        throw error;
      }
    },
    async readBytes(session, capability, path, maxBytes, signal) {
      try {
        const answer = (await options.server.workspace(
          "workspace.read",
          {
            session: sessionOf(session),
            spec: capability.sandbox ?? {},
            bytes: { path, maxBytes },
          },
          signal,
          target
        )) as { kind: string; path?: string; base64?: string; code?: string; message?: string };
        if (answer.kind === "read")
          return { kind: "read", path: String(answer.path), bytes: new Uint8Array(Buffer.from(String(answer.base64), "base64")) };
        if (answer.kind === "missing") return { kind: "missing", path: String(answer.path) };
        return { kind: "failed", code: String(answer.code), message: String(answer.message) };
      } catch (error) {
        if (error instanceof NoWorkspaceHarness)
          return { kind: "failed", code: "sandbox.unavailable", message: error.message };
        throw error;
      }
    },
    async report() {
      const answer = await ask("workspace.report", {}).catch(() => undefined);
      if (answer) return answer as unknown as WorkspaceReport;
      return {
        preference: options.preference === "virtual" ? "virtual" : "auto",
        backend: null,
        isolation: null,
        reason: "No harness serving workspaces is connected",
        probes: [],
        defaultImage: DEFAULT_SANDBOX_IMAGE,
      };
    },
    sweep: (pass) => sweep(pass.sessionExists, pass.sandboxExists, pass.now),
    async removeSandbox(sandboxId) {
      // With no harness connected, the next sweep removes it: its resource is gone.
      await ask("workspace.remove", { sandboxIds: [sandboxId] });
      await store.tx(async (t) => {
        for (const row of await t.listSandboxes<WorkspaceRecord>())
          if (row.sandboxId === sandboxId) await t.delete("sandboxes", row.key);
      });
    },
    async removeAll() {
      await ask("workspace.remove", { all: true });
    },
    async close() {},
  };
}

/**
 * Routes the workspaces of sessions attached to a pod sandbox to that sandbox's engine (F7.2);
 * everything else goes to `base`. `podOf` says whether a sandbox resource is a pod sandbox.
 */
export function withPodWorkspaces(
  base: WorkspacePort,
  options: Omit<RemoteWorkspaceOptions, "pod"> & {
    readonly isPod: (sandboxId: string) => Promise<boolean>;
  }
): WorkspacePort {
  const routed = async (session: SandboxSessionRef): Promise<WorkspacePort> =>
    session.sandboxId !== undefined && (await options.isPod(session.sandboxId))
      ? remoteWorkspace({ ...options, pod: session.sandboxId })
      : base;
  return {
    ...base,
    run: async (session, capability, toolName, input, signal) =>
      (await routed(session)).run(session, capability, toolName, input, signal),
    listFiles: async (session, capability, dir, maxEntries, signal) =>
      (await routed(session)).listFiles(session, capability, dir, maxEntries, signal),
    readBytes: async (session, capability, path, maxBytes, signal) =>
      (await routed(session)).readBytes(session, capability, path, maxBytes, signal),
  };
}
