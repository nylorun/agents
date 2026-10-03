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
}

/** The workspaces of the harness that serves them. */
export function remoteWorkspace(options: RemoteWorkspaceOptions): WorkspacePort {
  const { store } = options;
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
            session: {
              ownerId: session.id,
              ...(session.sandboxId === undefined ? {} : { sandboxId: session.sandboxId }),
              activeTurnId: session.activeTurnId,
            },
            spec: capability.sandbox ?? {},
            tool: toolName,
            input: input ?? {},
          },
          signal
        )) as unknown as SandboxToolOutcome;
      } catch (error) {
        if (error instanceof NoWorkspaceHarness)
          return fail(503, error.message, { code: "request_rejected" });
        if (error instanceof HarnessApiError && error.code === "unavailable" && !signal.aborted)
          return fail(503, `The harness serving workspaces went away: ${error.message}`, {
            code: "request_rejected",
          });
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
