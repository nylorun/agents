/**
 * A harness service (F6.2): a harness that runs the Tenant's segments and serves its workspaces
 * over the Harness API, with its own MCP pool and SandboxManager, and no store. `main.ts` runs
 * one as `--service harness`; a Tenant opened with `harness: "ws"` (tests) runs one in its own
 * process over a loopback WebSocket.
 *
 * It learns its Tenant and the sandbox backend preference from core's answer to `hello`, and
 * only then creates its SandboxManager: workspace keys are scoped by the Tenant. The manager
 * keeps its compute records in `<sandboxes>/records.json` and claims its events from core
 * (`event`): for the run that made the call, or the workspace request core sent.
 */
import { fromWireOp, toWireAnswer, type WireDiskOp } from "../sandbox/disk-fs.js";
import { join } from "node:path";
import {
  DEFAULT_HARNESS,
  HarnessApiError,
  type RequestHandler,
  type WorkspaceCall,
  type WorkspaceDiskCall,
  type WorkspaceSession,
} from "@nylorun/core/harness-api";
import type { SandboxManifest, SandboxToolName } from "@nylorun/core/define";
import type { HarnessOptions } from "@nylorun/harness/api";
import type { ModelGate } from "../gates/model-gate.js";
import { openMcpThrough, type ToolGate } from "../gates/tool-gate.js";
import { McpPool } from "../mcp/pool.js";
import { SandboxManager } from "../sandbox/manager.js";
import { fileSandboxRecords, workspacePrefix } from "../sandbox/records.js";
import { defaultSandboxBackends } from "../sandbox/select.js";
import type { SandboxBackend } from "../sandbox/types.js";
import { harnessExecutors } from "./executors.js";
import { connectHarness, type HarnessClient, type HarnessClientOptions } from "./ws-client.js";

/** Which request runs each sandbox tool. */
const METHODS: Readonly<Record<SandboxToolName, string>> = {
  bash: "workspace.exec",
  read: "workspace.read",
  grep: "workspace.read",
  glob: "workspace.read",
  write: "workspace.write",
  edit: "workspace.write",
};

/** How often the harness closes MCP connections idle past their timeout. */
const MCP_SWEEP_MS = 60_000;

export interface HarnessServiceOptions {
  readonly url: string;
  readonly token: HarnessClientOptions["token"];
  /** Where workspaces (and their records) live. */
  readonly paths: { readonly sandboxes: string };
  /** Every model call (the gates service's client; a scripted model's gate in tests). */
  readonly modelGate: ModelGate;
  /**
   * Remote MCP servers (`openMcp`), HTTP tools and keyed cancels: the gates service's client. A
   * harness process has no vault: it opens MCP servers only through the Tool Gate.
   */
  readonly toolGate: Pick<ToolGate, "recovers" | "cancel" | "openMcp" | "callHttp">;
  /** Default: the virtual backend under `paths.sandboxes`. */
  readonly sandboxBackends?: readonly SandboxBackend[];
  /** Delete the workspaces on stop (an ephemeral Runtime's loopback harness). */
  readonly ephemeral?: boolean;
  /**
   * The sandbox tools' limits: what our engine's schemas name and what this harness runs them
   * with. Each left out is its default (`DEFAULT_SANDBOX_TOOL_LIMITS`).
   */
  readonly sandboxTools?: HarnessOptions["sandboxTools"];
  readonly logger: HarnessClientOptions["logger"];
  readonly version?: string;
  readonly onGrant?: HarnessOptions["onGrant"];
  readonly backoff?: HarnessClientOptions["backoff"];
  readonly liveness?: HarnessClientOptions["liveness"];
}

export interface HarnessService {
  readonly client: HarnessClient;
  /** Stops leasing and gives runs back (at most `waitMs`), then closes MCP and sandboxes. */
  stop(waitMs?: number): Promise<void>;
}

/** The SandboxManager's view of the session a workspace request acts for. */
function refOf(session: WorkspaceSession) {
  return {
    id: session.ownerId,
    activeTurnId: session.activeTurnId,
    ...(session.environmentId === undefined ? {} : { environmentId: session.environmentId }),
  };
}

export function startHarnessService(options: HarnessServiceOptions): HarnessService {
  const { logger } = options;
  const backends = options.sandboxBackends ?? defaultSandboxBackends({ root: options.paths.sandboxes });
  let tenantId = "";
  let manager: SandboxManager | undefined;
  let client!: HarnessClient;

  const sandbox = () => {
    if (!manager) throw new HarnessApiError("unavailable", "The harness has not said hello yet");
    return manager;
  };

  const pool = new McpPool({ openRemote: openMcpThrough(options.toolGate) });
  const sweep = setInterval(() => void pool.sweep().catch(() => undefined), MCP_SWEEP_MS);
  sweep.unref();

  const executors = harnessExecutors({
    model: {
      get tenantId() {
        return tenantId;
      },
      modelGate: options.modelGate,
    },
    toolGate: options.toolGate,
    mcp: pool,
    sandbox,
    ...(options.sandboxTools ? { sandboxTools: options.sandboxTools } : {}),
  });

  const serve: RequestHandler = async (method, params, signal) => {
    switch (method) {
      case "workspace.read":
      case "workspace.write":
      case "workspace.exec": {
        if ("disk" in (params as object)) {
          // A disk version's read or write (R2d step 3).
          const call = params as WorkspaceDiskCall;
          const answer = await sandbox().disk(
            refOf(call.session),
            call.spec as SandboxManifest,
            fromWireOp(call.disk as WireDiskOp),
            signal
          );
          return "code" in answer ? answer : toWireAnswer(answer);
        }
        const call = params as WorkspaceCall;
        if (METHODS[call.tool as SandboxToolName] !== method)
          throw new HarnessApiError("invalid", `${method} does not run ${call.tool}`);
        return sandbox().run(
          refOf(call.session),
          call.spec as SandboxManifest,
          call.tool as SandboxToolName,
          call.input,
          signal
        );
      }
      case "workspace.report":
        return sandbox().report();
      case "workspace.sweep": {
        const { now } = params as { now?: number };
        await sandbox().stopIdle(now);
        return { workspaces: await sandbox().workspaces() };
      }
      case "workspace.remove": {
        const { keys, environmentIds, all } = params as { keys?: string[]; environmentIds?: string[]; all?: true };
        const workspaces = sandbox();
        if (all) {
          await workspaces.reconcile(() => false, () => false);
          for (const record of await workspaces.workspaces()) await workspaces.remove(record.key);
        }
        for (const key of keys ?? []) {
          if (!key.startsWith(workspacePrefix(tenantId)))
            throw new HarnessApiError("invalid", `${key} is not a workspace of this Tenant`);
          await workspaces.remove(key);
        }
        for (const id of environmentIds ?? []) await workspaces.removeSandbox(id);
        return {};
      }
      default:
        throw new HarnessApiError("invalid", `Unknown request ${method}`);
    }
  };

  client = connectHarness({
    url: options.url,
    token: options.token,
    logger,
    executors,
    serve,
    // Our harness: its hello names our harness id (R4.1).
    name: DEFAULT_HARNESS,
    ...(options.version ? { version: options.version } : {}),
    features: { workspace: { backends: backends.map((backend) => backend.name) } },
    ...(options.sandboxTools ? { sandboxTools: options.sandboxTools } : {}),
    onHello(answer) {
      tenantId = answer.tenantId;
      manager ??= new SandboxManager({
        scope: answer.tenantId,
        records: fileSandboxRecords(join(options.paths.sandboxes, "records.json")),
        backends,
        preference: answer.sandbox.backend ?? "auto",
        ephemeral: options.ephemeral === true,
        // A claim core refuses (its run ended, the session is gone) is dropped, as core's own
        // SandboxManager drops an event it cannot write.
        emit: async (sessionId, turnId, type, payload, meta) => {
          const channel = client.channel();
          if (!channel) return;
          await channel
            .request("event", {
              ...(meta.claim === undefined ? {} : { runId: meta.claim }),
              sessionId,
              turnId,
              type,
              payload,
              ...(meta.record ? { record: meta.record } : {}),
            })
            .catch((error: unknown) =>
              logger.warn("harness sandbox event not claimed", {
                sessionId,
                type,
                message: error instanceof Error ? error.message : String(error),
              })
            );
        },
      });
    },
    ...(options.onGrant ? { onGrant: options.onGrant } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    ...(options.liveness ? { liveness: options.liveness } : {}),
  });

  return {
    client,
    async stop(waitMs) {
      clearInterval(sweep);
      await client.stop(waitMs);
      await pool.close();
      await manager?.close();
    },
  };
}
