/**
 * Sandbox Manager: owns sandbox lifecycle for the Runtime. One sandbox per session, created on
 * the first sandbox tool call, stopped after its idle timeout, reattached on the next call.
 * Commands against one sandbox run one at a time.
 *
 * The manager keeps no timers. The Tenant sweep calls `sweep`, which stops sandboxes idle
 * past their timeout, marks records of compute this process no longer holds as stopped
 * (after a restart), and, once per process, removes sandboxes whose session is gone.
 */
import type { EventPayload } from "@nylorun/core/contracts";
import { createHash } from "node:crypto";
import {
  isSandboxToolName,
  type AgentManifest,
  type CapabilityManifest,
  type SandboxToolName,
} from "@nylorun/core/define";
import type { SessionStore } from "../store/types.js";
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
  /** Tool calls running now. */
  active: number;
  /** When the last tool call ended (ms since the epoch). */
  lastUsedAt: number;
  tail: Promise<unknown>;
}

export interface SandboxSweepOptions {
  /** The sweep's clock, in ms since the epoch. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Whether a session still exists; sandboxes of deleted sessions are removed. */
  readonly sessionExists: (sessionId: string) => boolean | Promise<boolean>;
}

export interface SandboxManagerOptions {
  /** Distinguishes this Runtime's sandboxes from other Runtimes on the same machine. */
  readonly scope: string;
  readonly store: SessionStore;
  readonly backends: readonly SandboxBackend[];
  /** `auto`, `virtual` or `openshell`. Undefined means an invalid NYLORUN_SANDBOX value. */
  readonly preference: string | undefined;
  /** Delete sandboxes on close (the Runtime's store does not outlive the process). */
  readonly ephemeral: boolean;
  /** Writes a session event in its own transaction; never called inside one. */
  readonly emit: <T extends SandboxEventType>(
    sessionId: string,
    turnId: string | null,
    type: T,
    payload: EventPayload<T>
  ) => void | Promise<void>;
}

/** The session events a sandbox writes. */
export type SandboxEventType = "sandbox.state" | "sandbox.exec";

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
  private reconciled = false;

  constructor(private readonly options: SandboxManagerOptions) {
    this.prefix = `nylorun-${options.scope}-`;
  }

  /**
   * One Tenant sweep pass:
   * - stops sandboxes idle for at least their idle timeout (their files remain; the next
   *   call reattaches);
   * - marks records whose compute this process does not hold as stopped (compute is gone
   *   after a Runtime restart);
   * - on the first pass of this process, removes sandboxes whose session no longer exists
   *   (skipped for ephemeral Runtimes, which delete theirs on close).
   */
  async sweep(options: SandboxSweepOptions): Promise<void> {
    if (this.closing) return;
    const now = options.now ?? Date.now();
    const idle = (live: Live) =>
      !!live.handle && live.active === 0 && now - live.lastUsedAt >= live.idleMs;
    const stops: Promise<unknown>[] = [];
    for (const [key, live] of this.live) {
      if (!idle(live)) continue;
      // Queued behind any call already waiting; checked again when its turn comes.
      live.tail = live.tail
        .then(() => (idle(live) ? this.stop(key, live) : undefined))
        .catch(() => undefined);
      stops.push(live.tail);
    }
    await Promise.all(stops);
    await this.options.store.tx(async (t) => {
      for (const record of await t.listSandboxes<SandboxRecord>()) {
        if (record.state === "stopped") continue;
        const live = this.live.get(record.key);
        if (live && (live.handle || live.active > 0)) continue;
        await t.put("sandboxes", record.key, { ...record, state: "stopped" });
      }
    });
    if (this.reconciled || this.options.ephemeral) return;
    this.reconciled = true;
    if (!(await this.hasRecords())) return;
    await this.reconcile(
      async (sessionId) =>
        [...this.live.values()].some((live) => live.sessionId === sessionId) ||
        (await options.sessionExists(sessionId))
    );
  }

  /** Backends are probed once, on first use, and the choice holds for the life of the Runtime. */
  get ready(): Promise<SandboxSelection> {
    if (!this.selection) {
      const preference = parseSandboxPreference(this.options.preference);
      this.selection = preference
        ? selectSandboxBackend(this.options.backends, preference)
        : Promise.resolve({
            preference: "auto",
            reason: `NYLORUN_SANDBOX='${this.options.preference}' is not valid; use auto, virtual or openshell`,
            probes: [],
          });
    }
    return this.selection;
  }

  /** Whether any sandbox was ever recorded, so startup can skip probing for agents without one. */
  async hasRecords(): Promise<boolean> {
    return (await this.options.store.tx((t) => t.counts())).sandboxes > 0;
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
      // The virtual backend reports the Runtime's default; others use their own (OpenShell's gateway).
      image:
        capability.sandbox?.image ?? (backend.name === "virtual" ? DEFAULT_SANDBOX_IMAGE : undefined),
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
      live = {
        sessionId: session.id,
        backend,
        idleMs: idleMsOf(capability.sandbox),
        active: 0,
        lastUsedAt: Date.now(),
        tail: Promise.resolve(),
      };
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
    live.active += 1;
    try {
      return await this.executeOpen(live, session, spec, toolName, input, signal);
    } finally {
      live.active -= 1;
      live.lastUsedAt = Date.now();
    }
  }

  private async executeOpen(
    live: Live,
    session: SandboxSessionRef,
    spec: SandboxSpec,
    toolName: SandboxToolName,
    input: unknown,
    signal: AbortSignal
  ): Promise<SandboxToolOutcome> {
    if (!live.handle) {
      try {
        live.handle = await this.open(live, session, spec);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.record(spec.key, session.id, live.backend.name, spec.image, "stopped");
        await this.options.emit(session.id, session.activeTurnId, "sandbox.state", {
          state: "stopped",
          backend: live.backend.name,
          error: message,
        });
        // Nothing ran yet, so a failed start is a definite outcome, not an uncertain one.
        return {
          kind: "failed",
          code: "sandbox.start_failed",
          message: `The sandbox could not start on ${live.backend.name} (image ${spec.image ?? "the backend's default"}): ${message}`,
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
      await this.options.emit(session.id, session.activeTurnId, "sandbox.exec", {
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
    }
  }

  private async open(live: Live, session: SandboxSessionRef, spec: SandboxSpec): Promise<SandboxHandle> {
    const existing = await this.options.store.tx((t) =>
      t.get<SandboxRecord>("sandboxes", spec.key)
    );
    const payload = {
      backend: live.backend.name,
      isolation: live.backend.isolation,
      image: spec.image,
      network: describeNetwork(spec.network),
    };
    await this.record(spec.key, session.id, live.backend.name, spec.image, "creating", existing);
    await this.options.emit(session.id, session.activeTurnId, "sandbox.state", {
      state: "creating",
      ...payload,
      ...(existing ? { reattach: true } : {}),
    });
    const handle = await live.backend.open(spec);
    await this.record(spec.key, session.id, live.backend.name, spec.image, "running", existing);
    await this.options.emit(session.id, session.activeTurnId, "sandbox.state", {
      state: "running",
      ...payload,
      ...(existing && handle.created
        ? { lost: true, note: "The sandbox was gone and was created again; its earlier files are lost." }
        : {}),
    });
    return handle;
  }

  private async stop(key: string, live: Live) {
    const handle = live.handle;
    if (!handle) return;
    live.handle = undefined;
    try {
      await handle.stop();
    } finally {
      await this.record(key, live.sessionId, live.backend.name, undefined, "stopped");
      await this.options.emit(live.sessionId, null, "sandbox.state", { state: "stopped", backend: live.backend.name });
    }
  }

  private async record(
    key: string,
    sessionId: string,
    backend: string,
    image: string | undefined,
    state: SandboxState,
    known?: SandboxRecord
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.options.store.tx(async (t) => {
      const existing = known ?? (await t.get<SandboxRecord>("sandboxes", key));
      await t.put("sandboxes", key, {
        key,
        sessionId,
        backend,
        image: image ?? existing?.image ?? "",
        state,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies SandboxRecord);
    });
  }

  /** The sandbox record for a session, if one was ever created. */
  status(sessionId: string): Promise<SandboxRecord | undefined> {
    return this.options.store.tx((t) =>
      t.get<SandboxRecord>("sandboxes", this.keyOf(sessionId))
    );
  }

  /** Delete sandboxes this Runtime owns whose session no longer exists. */
  async reconcile(
    sessionExists: (sessionId: string) => boolean | Promise<boolean>
  ): Promise<void> {
    const { backend } = await this.ready;
    if (!backend) return;
    for (const key of await backend.list(this.prefix)) {
      const record = await this.options.store.tx((t) =>
        t.get<SandboxRecord>("sandboxes", key)
      );
      if (record && (await sessionExists(record.sessionId))) continue;
      await backend.remove(key);
      await this.options.store.tx((t) => t.delete("sandboxes", key));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.selection) return;
    const tasks = [...this.live.entries()].map(async ([key, live]) => {
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
