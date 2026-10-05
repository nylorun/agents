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
import { join } from "node:path";
import {
  HarnessApiError,
  type RequestHandler,
  type WorkspaceBytesCall,
  type WorkspaceCall,
  type WorkspaceListCall,
  type WorkspaceSession,
} from "@nylorun/core/harness-api";
import type { CapabilityManifest, SandboxManifest, SandboxToolName } from "@nylorun/core/define";
import type { HarnessOptions } from "@nylorun/harness/api";
import type { ModelProvider } from "../core/provider.js";
import type { ModelGate } from "../gates/model-gate.js";
import type { ToolGate } from "../gates/tool-gate.js";
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
  /** Where workspaces (and their records) live, and the plugins' data. */
  readonly paths: { readonly sandboxes: string; readonly pluginData: string };
  /** The environment of MCP stdio servers: the allowlisted base, with HOME and TMPDIR. */
  readonly childEnv: Readonly<Record<string, string>>;
  /** Vault-backed model calls (the gates service's client). */
  readonly modelGate: ModelGate;
  /** Models served without the vault; a harness process has none (`useVaultModel`). */
  readonly modelProvider?: ModelProvider;
  readonly useVaultModel: boolean;
  /** Remote MCP servers (`openMcp`) and keyed cancels; the gates service's client. */
  readonly toolGate: Pick<ToolGate, "recovers" | "cancel" | "openMcp">;
  /**
   * Authorizes a remote MCP server opened in this process. A harness process has no vault: it
   * opens remote servers through the Tool Gate, and refuses them without one.
   */
  readonly authorize?: ConstructorParameters<typeof McpPool>[0]["authorize"];
  /** How remote MCP servers opened in this process are reached (`TenantConfig.delivery`). */
  readonly delivery?: ConstructorParameters<typeof McpPool>[0]["policy"];
  /** Default: the virtual backend under `paths.sandboxes`. */
  readonly sandboxBackends?: readonly SandboxBackend[];
  /** Delete the workspaces on stop (an ephemeral Runtime's loopback harness). */
  readonly ephemeral?: boolean;
  readonly logger: HarnessClientOptions["logger"];
  readonly name?: string;
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
    ...(session.sandboxId === undefined ? {} : { sandboxId: session.sandboxId }),
  };
}

const noModel: ModelProvider = async () => {
  throw new Error("This harness calls models only through the gates service");
};

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

  const pool = new McpPool({
    pluginData: options.paths.pluginData,
    childEnv: options.childEnv,
    authorize:
      options.authorize ??
      (async () => {
        throw new Error("This harness opens remote MCP servers only through the gates service");
      }),
    ...(options.delivery ? { policy: options.delivery } : {}),
    ...(options.toolGate.openMcp ? { openRemote: (server) => options.toolGate.openMcp!(server) } : {}),
  });
  const sweep = setInterval(() => void pool.sweep().catch(() => undefined), MCP_SWEEP_MS);
  sweep.unref();

  const executors = harnessExecutors({
    model: {
      get tenantId() {
        return tenantId;
      },
      modelGate: options.modelGate,
      modelProvider: options.modelProvider ?? noModel,
      useVaultModel: options.useVaultModel,
    },
    toolGate: options.toolGate,
    mcp: pool,
    sandbox,
  });

  const serve: RequestHandler = async (method, params, signal) => {
    switch (method) {
      case "workspace.read":
      case "workspace.write":
      case "workspace.exec": {
        if (method === "workspace.read" && "list" in (params as object)) {
          const call = params as WorkspaceListCall;
          return sandbox().listFiles(
            refOf(call.session),
            { id: "sandbox", type: "agent", sandbox: call.spec as SandboxManifest, tools: [] } as CapabilityManifest,
            call.list.dir,
            call.list.maxEntries,
            signal
          );
        }
        if (method === "workspace.read" && "bytes" in (params as object)) {
          const call = params as WorkspaceBytesCall;
          const read = await sandbox().readBytes(
            refOf(call.session),
            { id: "sandbox", type: "agent", sandbox: call.spec as SandboxManifest, tools: [] } as CapabilityManifest,
            call.bytes.path,
            call.bytes.maxBytes,
            signal
          );
          return read.kind === "read"
            ? { kind: "read", path: read.path, base64: Buffer.from(read.bytes).toString("base64") }
            : read;
        }
        const call = params as WorkspaceCall;
        if (METHODS[call.tool as SandboxToolName] !== method)
          throw new HarnessApiError("invalid", `${method} does not run ${call.tool}`);
        return sandbox().run(
          refOf(call.session),
          { id: "sandbox", type: "agent", sandbox: call.spec as SandboxManifest, tools: [] } as CapabilityManifest,
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
        const { keys, sandboxIds, all } = params as { keys?: string[]; sandboxIds?: string[]; all?: true };
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
        for (const id of sandboxIds ?? []) await workspaces.removeSandbox(id);
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
    name: options.name ?? "harness",
    ...(options.version ? { version: options.version } : {}),
    capabilities: { workspace: { backends: backends.map((backend) => backend.name) } },
    onHello(answer) {
      tenantId = answer.tenantId;
      manager ??= new SandboxManager({
        scope: answer.tenantId,
        records: fileSandboxRecords(join(options.paths.sandboxes, "records.json")),
        backends,
        preference: answer.sandbox.backend ?? "auto",
        ephemeral: options.ephemeral === true,
        // A skill file's bytes come from core, for the run that made the call.
        definitionFile: async (sha256, session) => {
          const channel = client.channel();
          if (!channel || session.claim === undefined)
            throw new Error(`No run to fetch ${sha256} for`);
          const { base64 } = await channel.request("definition.file", { runId: session.claim, sha256 });
          return new Uint8Array(Buffer.from(base64, "base64"));
        },
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
