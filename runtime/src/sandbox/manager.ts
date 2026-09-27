/**
 * Sandbox Manager: owns sandbox lifecycle for the Runtime. One sandbox per session, created on
 * the first sandbox tool call, stopped after its idle timeout, reattached on the next call.
 * Commands against one sandbox run one at a time.
 */
import { createHash } from "node:crypto";
import {
  isSandboxToolName,
  type AgentManifest,
  type CapabilityManifest,
  type SandboxToolName,
} from "@nylorun/core/define";
import type { Store } from "../core/store.js";
import {
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_IMAGE,
  describeNetwork,
  idleMsOf,
  memoryMiBOf,
  resolveNetwork,
} from "./policy.js";
import {
  parseSandboxPreference,
  reportSelection,
  selectSandboxBackend,
  type SandboxSelection,
  type SandboxSelectionReport,
} from "./select.js";
import { runSandboxTool, type SandboxToolOutcome, type SandboxToolReport } from "./tools.js";
import type { SandboxBackend, SandboxHandle, SandboxSpec } from "./types.js";

export interface SandboxSessionRef {
  readonly id: string;
  readonly activeTurnId: string | null;
  readonly manifest: AgentManifest;
}

export type SandboxState = "creating" | "running" | "stopped";

interface SandboxRecord {
  key: string;
  sessionId: string;
  backend: string;
  image: string;
  state: SandboxState;
  createdAt: string;
  updatedAt: string;
}

interface Live {
  readonly sessionId: string;
  readonly backend: SandboxBackend;
  handle?: SandboxHandle;
  idleMs: number;
  timer?: NodeJS.Timeout;
  tail: Promise<unknown>;
}

export interface SandboxManagerOptions {
  /** Distinguishes this Runtime's sandboxes from other Runtimes on the same machine. */
  readonly scope: string;
  readonly store: Store;
  readonly backends: readonly SandboxBackend[];
  /** `auto` or `virtual`. Undefined means an invalid NYLORUN_SANDBOX value. */
  readonly preference: string | undefined;
  /** Delete sandboxes on close (the Runtime's store does not outlive the process). */
  readonly ephemeral: boolean;
  readonly emit: (sessionId: string, turnId: string | null, type: string, payload: unknown) => void;
}

const READ_TOOLS = new Set<SandboxToolName>(["read", "grep", "glob"]);

/** The sandbox capability that owns this tool call, when the call is a built-in sandbox tool. */
export function sandboxCapabilityOf(
  manifest: AgentManifest | undefined,
  capabilityId: string | undefined,
  toolName: string | undefined
): CapabilityManifest | undefined {
  if (!manifest || !capabilityId || !toolName || !isSandboxToolName(toolName)) return undefined;
  const capability = manifest.capabilities.find((item) => item.id === capabilityId);
  return capability?.sandbox && capability.tools?.some((tool) => tool.name === toolName)
    ? capability
    : undefined;
}

export class SandboxManager {
  private selection?: Promise<SandboxSelection>;
  private readonly live = new Map<string, Live>();
  private readonly prefix: string;
  private closing = false;

  constructor(private readonly options: SandboxManagerOptions) {
    this.prefix = `nylorun-${options.scope}-`;
    // Compute is gone after a Runtime restart; files remain and the next call reattaches.
    options.store.tx(() => {
      for (const record of options.store.all<SandboxRecord>("sandboxes"))
        if (record.state !== "stopped")
          options.store.put("sandboxes", record.key, { ...record, state: "stopped" });
    });
  }

  /** Backends are probed once, on first use, and the choice holds for the life of the Runtime. */
  get ready(): Promise<SandboxSelection> {
    if (!this.selection) {
      const preference = parseSandboxPreference(this.options.preference);
      this.selection = preference
        ? selectSandboxBackend(this.options.backends, preference)
        : Promise.resolve({
            preference: "auto",
            reason: `NYLORUN_SANDBOX='${this.options.preference}' is not valid; use auto or virtual`,
            probes: [],
          });
    }
    return this.selection;
  }

  /** Whether any sandbox was ever recorded, so startup can skip probing for agents without one. */
  hasRecords(): boolean {
    return this.options.store.all("sandboxes").length > 0;
  }

  keyOf(sessionId: string): string {
    return this.prefix + createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  }

  async report(): Promise<SandboxSelectionReport & { readonly defaultImage: string }> {
    return { ...reportSelection(await this.ready), defaultImage: DEFAULT_SANDBOX_IMAGE };
  }

  async run(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    toolName: SandboxToolName,
    input: unknown,
    signal: AbortSignal
  ): Promise<SandboxToolOutcome> {
    const selection = await this.ready;
    const backend = selection.backend;
    if (!backend)
      return {
        kind: "failed",
        code: "sandbox.unavailable",
        message: `No sandbox is available: ${selection.reason}. Run \`npx nylorun doctor sandbox\` for options.`,
      };
    const key = this.keyOf(session.id);
    const spec: SandboxSpec = {
      key,
      image: capability.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE,
      cpus: capability.sandbox?.resources?.cpus ?? DEFAULT_SANDBOX_CPUS,
      memoryMiB: memoryMiBOf(capability.sandbox),
      network: resolveNetwork(capability.sandbox),
    };
    const unmet = backend.unmet(spec);
    if (unmet)
      return {
        kind: "failed",
        code: "sandbox.unavailable",
        message: `This agent's sandbox cannot run on the ${backend.name} backend: ${unmet}.`,
      };
    let live = this.live.get(key);
    if (!live) {
      live = { sessionId: session.id, backend, idleMs: idleMsOf(capability.sandbox), tail: Promise.resolve() };
      this.live.set(key, live);
    }
    const entry = live;
    const task = entry.tail.then(() => this.execute(entry, session, spec, toolName, input, signal));
    entry.tail = task.catch(() => undefined);
    return task;
  }

  private async execute(
    live: Live,
    session: SandboxSessionRef,
    spec: SandboxSpec,
    toolName: SandboxToolName,
    input: unknown,
    signal: AbortSignal
  ): Promise<SandboxToolOutcome> {
    if (signal.aborted) throw new Error("Turn cancelled");
    if (this.closing) throw new Error("Runtime is shutting down");
    clearTimeout(live.timer);
    if (!live.handle) {
      try {
        live.handle = await this.open(live, session, spec);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.record(spec.key, session.id, live.backend.name, spec.image, "stopped");
        this.options.emit(session.id, session.activeTurnId, "sandbox.state", {
          state: "stopped",
          backend: live.backend.name,
          error: message,
        });
        // Nothing ran yet, so a failed start is a definite outcome, not an uncertain one.
        return {
          kind: "failed",
          code: "sandbox.start_failed",
          message: `The sandbox could not start on ${live.backend.name} (image ${spec.image}): ${message}`,
        };
      }
    }
    const started = Date.now();
    let report: SandboxToolReport = {};
    try {
      const outcome = await runSandboxTool(
        live.handle,
        toolName,
        (input ?? {}) as Record<string, any>,
        signal,
        (value) => {
          report = value;
        }
      );
      this.options.emit(session.id, session.activeTurnId, "sandbox.exec", {
        tool: toolName,
        ...report,
        ...(report.command ? { command: report.command.slice(0, 500) } : {}),
        outcome: outcome.kind,
        ...(outcome.kind === "failed" ? { code: outcome.code } : {}),
        durationMs: Date.now() - started,
      });
      return outcome;
    } catch (error) {
      // The backend itself failed; reopen on the next call.
      live.handle = undefined;
      if (signal.aborted || !READ_TOOLS.has(toolName)) throw error;
      return {
        kind: "failed",
        code: "sandbox.error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.armIdle(spec.key, live);
    }
  }

  private async open(live: Live, session: SandboxSessionRef, spec: SandboxSpec): Promise<SandboxHandle> {
    const existing = this.options.store.get<SandboxRecord>("sandboxes", spec.key);
    const payload = {
      backend: live.backend.name,
      isolation: live.backend.isolation,
      image: spec.image,
      network: describeNetwork(spec.network),
    };
    this.record(spec.key, session.id, live.backend.name, spec.image, "creating", existing);
    this.options.emit(session.id, session.activeTurnId, "sandbox.state", {
      state: "creating",
      ...payload,
      ...(existing ? { reattach: true } : {}),
    });
    const handle = await live.backend.open(spec);
    this.record(spec.key, session.id, live.backend.name, spec.image, "running", existing);
    this.options.emit(session.id, session.activeTurnId, "sandbox.state", { state: "running", ...payload });
    return handle;
  }

  private armIdle(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.closing) return;
    live.timer = setTimeout(() => {
      live.tail = live.tail.then(() => this.stop(key, live)).catch(() => undefined);
    }, live.idleMs);
    live.timer.unref();
  }

  private async stop(key: string, live: Live) {
    const handle = live.handle;
    if (!handle) return;
    live.handle = undefined;
    try {
      await handle.stop();
    } finally {
      this.record(key, live.sessionId, live.backend.name, undefined, "stopped");
      this.options.emit(live.sessionId, null, "sandbox.state", { state: "stopped", backend: live.backend.name });
    }
  }

  private record(
    key: string,
    sessionId: string,
    backend: string,
    image: string | undefined,
    state: SandboxState,
    existing = this.options.store.get<SandboxRecord>("sandboxes", key)
  ) {
    const now = new Date().toISOString();
    this.options.store.tx(() =>
      this.options.store.put("sandboxes", key, {
        key,
        sessionId,
        backend,
        image: image ?? existing?.image ?? "",
        state,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies SandboxRecord)
    );
  }

  /** The sandbox record for a session, if one was ever created. */
  status(sessionId: string): SandboxRecord | undefined {
    return this.options.store.get<SandboxRecord>("sandboxes", this.keyOf(sessionId));
  }

  /** Delete sandboxes this Runtime owns whose session no longer exists. */
  async reconcile(sessionExists: (sessionId: string) => boolean): Promise<void> {
    const { backend } = await this.ready;
    if (!backend) return;
    for (const key of await backend.list(this.prefix)) {
      const record = this.options.store.get<SandboxRecord>("sandboxes", key);
      if (record && sessionExists(record.sessionId)) continue;
      await backend.remove(key);
      this.options.store.tx(() => this.options.store.delete("sandboxes", key));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.selection) return;
    const tasks = [...this.live.entries()].map(async ([key, live]) => {
      clearTimeout(live.timer);
      await live.tail;
      if (this.options.ephemeral) {
        live.handle = undefined;
        await live.backend.remove(key);
      } else await this.stop(key, live);
    });
    await Promise.allSettled(tasks);
    this.live.clear();
  }
}
