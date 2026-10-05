/**
 * Sandbox Manager: owns sandbox lifecycle for the Runtime. One workspace per sandbox resource
 * (`sandbox: { id }`, keyed by the sandbox id), or per owning session for a sandbox chosen
 * inline or by the Tenant default (keyed by the session id); created on the first sandbox tool
 * call, stopped after its idle timeout, reattached on the next call. Commands against one
 * workspace run one at a time, whichever session sends them.
 *
 * The manager keeps no timers and reaches no store: it keeps its compute records through a
 * `SandboxRecords` port (the Tenant's `sandboxes` table in core's process, a file in a harness's)
 * and writes its events through `emit`. Its owner drives it: `stopIdle` stops sandboxes idle
 * past their timeout and marks records of compute this process no longer holds as stopped
 * (after a restart); `reconcile` removes workspaces whose owner is gone. `sweep` does both, the
 * reconcile once per process, as the Tenant sweep does in core's process.
 *
 * A session's skills (track R2 M4) are mounted on its workspace, read-only under
 * `/skills/<name>/`, before the first call that opens it (`skills.ts`); their bytes come
 * through the `definitionFile` port.
 */
import type { EventPayload } from "@nylorun/core/contracts";
import {
  SANDBOX_WORKSPACE,
  type AgentManifest,
  type CapabilityManifest,
  type SandboxToolName,
} from "@nylorun/core/define";
import {
  sandboxWorkspaceKey,
  sessionWorkspaceKey,
  workspacePrefix,
  type SandboxRecord,
  type SandboxRecords,
  type SandboxState,
} from "./records.js";
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
import { mountSkill, sandboxSkillsOf, skillSignature } from "./skills.js";
import {
  resolveSandboxPath,
  runSandboxTool,
  type SandboxToolOutcome,
  type SandboxToolReport,
} from "./tools.js";
import {
  SandboxFileTooLargeError,
  type SandboxBackend,
  type SandboxHandle,
  type SandboxListing,
  type SandboxSpec,
} from "./types.js";

export { sandboxCapabilityOf } from "./capability.js";
export type { SandboxRecord, SandboxRecords, SandboxState } from "./records.js";

export interface SandboxSessionRef {
  /** The session whose log records the workspace's events: the owning session. */
  readonly id: string;
  readonly activeTurnId: string | null;
  readonly manifest?: AgentManifest;
  /**
   * The sandbox resource the owning session is attached to. Its workspace is keyed by this id,
   * so every session attached to it shares the files; absent, the workspace is the session's.
   */
  readonly sandboxId?: string;
  /**
   * Who the call's events are claimed for, passed back to `emit`: in a harness, the run that
   * made the call (its run id).
   */
  readonly claim?: string;
}

/** What `emit` gets with an event besides its payload. */
export interface SandboxEventMeta {
  /** With `sandbox.state`: the workspace's record as it is now. */
  readonly record?: SandboxRecord;
  /** The `claim` of the call that caused the event; absent for an idle stop. */
  readonly claim?: string;
}

interface Live {
  readonly sessionId: string;
  readonly sandboxId?: string;
  readonly backend: SandboxBackend;
  handle?: SandboxHandle;
  idleMs: number;
  /** Tool calls running now. */
  active: number;
  /** When the last tool call ended (ms since the epoch). */
  lastUsedAt: number;
  tail: Promise<unknown>;
  /** The skills mounted on the open handle, by name: what each holds (`skillSignature`). */
  skills: Map<string, string>;
}

export interface SandboxSweepOptions {
  /** The sweep's clock, in ms since the epoch. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Whether a session still exists; sandboxes of deleted sessions are removed. */
  readonly sessionExists: (sessionId: string) => boolean | Promise<boolean>;
  /** Whether a sandbox resource still exists. Default: every one does. */
  readonly sandboxExists?: (sandboxId: string) => boolean | Promise<boolean>;
}

export interface SandboxManagerOptions {
  /** Distinguishes this Runtime's sandboxes from other Runtimes on the same machine: the Tenant id. */
  readonly scope: string;
  /** Where the workspaces' compute records are kept. */
  readonly records: SandboxRecords;
  readonly backends: readonly SandboxBackend[];
  /** `auto` or `virtual`. Undefined means an invalid NYLORUN_SANDBOX value. */
  readonly preference: string | undefined;
  /** Delete sandboxes on close (the Runtime's store does not outlive the process). */
  readonly ephemeral: boolean;
  /**
   * A definition file's bytes by `sha256:<hex>`, for the skills a session's workspace mounts:
   * the Tenant's Object store in core's process, core's answer in a harness (for the run that
   * made the call, `session.claim`). Without it no skills are mounted.
   */
  readonly definitionFile?: (sha256: string, session: SandboxSessionRef) => Promise<Uint8Array>;
  /** Writes a session event (in core, in its own transaction; in a harness, as a claim). */
  readonly emit: <T extends SandboxEventType>(
    sessionId: string,
    turnId: string | null,
    type: T,
    payload: EventPayload<T>,
    meta: SandboxEventMeta
  ) => void | Promise<void>;
}

/** The session events a sandbox writes. */
export type SandboxEventType = "sandbox.state" | "sandbox.exec";

const READ_TOOLS = new Set<SandboxToolName>(["read", "grep", "glob"]);

export class SandboxManager {
  private selection?: Promise<SandboxSelection>;
  private readonly live = new Map<string, Live>();
  private readonly prefix: string;
  private closing = false;
  private reconciled = false;

  constructor(private readonly options: SandboxManagerOptions) {
    this.prefix = workspacePrefix(options.scope);
  }

  /**
   * One sweep pass of core's process: `stopIdle`, then, on the first pass of this process,
   * `reconcile` (skipped for ephemeral Runtimes, which delete theirs on close).
   */
  async sweep(options: SandboxSweepOptions): Promise<void> {
    if (this.closing) return;
    await this.stopIdle(options.now);
    if (this.reconciled || this.options.ephemeral) return;
    this.reconciled = true;
    if (!(await this.hasRecords())) return;
    await this.reconcile(
      async (sessionId) =>
        [...this.live.values()].some((live) => live.sessionId === sessionId) ||
        (await options.sessionExists(sessionId)),
      options.sandboxExists ?? (() => true)
    );
  }

  /**
   * Stops sandboxes idle for at least their idle timeout (their files remain; the next call
   * reattaches), and marks records whose compute this process does not hold as stopped
   * (compute is gone after a restart).
   */
  async stopIdle(at?: number): Promise<void> {
    if (this.closing) return;
    const now = at ?? Date.now();
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
    for (const record of await this.options.records.list()) {
      if (record.state === "stopped") continue;
      const live = this.live.get(record.key);
      if (live && (live.handle || live.active > 0)) continue;
      await this.options.records.put({ ...record, state: "stopped" });
    }
  }

  /** Every workspace record this manager keeps. */
  workspaces(): Promise<SandboxRecord[]> {
    return this.options.records.list();
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
  async hasRecords(): Promise<boolean> {
    return (await this.options.records.count()) > 0;
  }

  keyOf(sessionId: string): string {
    return sessionWorkspaceKey(this.options.scope, sessionId);
  }

  /** The workspace key of sandbox resource `sandboxId` (`sandboxWorkspaceKey`). */
  sandboxKeyOf(sandboxId: string): string {
    return sandboxWorkspaceKey(this.options.scope, sandboxId);
  }

  private keyFor(session: SandboxSessionRef): string {
    return session.sandboxId === undefined
      ? this.keyOf(session.id)
      : this.sandboxKeyOf(session.sandboxId);
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
    const prepared = await this.prepare(session, capability);
    if ("kind" in prepared) return prepared;
    const { live: entry, spec } = prepared;
    const task = entry.tail.then(() => this.execute(entry, session, spec, toolName, input, signal));
    entry.tail = task.catch(() => undefined);
    return task;
  }

  /**
   * The bytes of one file in the session's sandbox, for `save_artifact` (F8.1), in the same queue
   * as its tool calls: `missing` when there is no such file, a failed outcome when the sandbox
   * cannot open or the file is larger than `maxBytes`. Relative paths resolve in the workspace.
   */
  async readBytes(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    path: string,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<
    | { kind: "read"; path: string; bytes: Uint8Array }
    | { kind: "missing"; path: string }
    | Extract<SandboxToolOutcome, { kind: "failed" }>
  > {
    return this.withHandle(session, capability, signal, async (handle, live) => {
      const resolved = resolveSandboxPath(path, handle.workspace ?? SANDBOX_WORKSPACE);
      if (!handle.readBytes)
        return {
          kind: "failed" as const,
          code: "sandbox.unsupported",
          message: `The ${live.backend.name} backend cannot read files as bytes`,
        };
      try {
        const bytes = await handle.readBytes(resolved, maxBytes);
        return bytes === undefined
          ? { kind: "missing" as const, path: resolved }
          : { kind: "read" as const, path: resolved, bytes };
      } catch (error) {
        if (error instanceof SandboxFileTooLargeError)
          return {
            kind: "failed" as const,
            code: "artifact.too_large",
            message: `${resolved} is ${error.size} bytes; an artifact may hold at most ${maxBytes}`,
          };
        throw error;
      }
    });
  }

  /**
   * The files under directory `dir` of the session's sandbox, for the turn-end export (F8.2), in
   * the same queue as its tool calls. `missing` when the sandbox was never created (nothing is
   * started to look) or `dir` is not a directory. Relative paths resolve in the workspace.
   */
  async listFiles(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    dir: string,
    maxEntries: number,
    signal: AbortSignal
  ): Promise<
    | { kind: "listed"; path: string; listing: SandboxListing }
    | { kind: "missing"; path: string }
    | Extract<SandboxToolOutcome, { kind: "failed" }>
  > {
    const key = this.keyFor(session);
    if (!this.live.get(key)?.handle) {
      const record = await this.options.records.get(key);
      if (!record) return { kind: "missing", path: dir };
    }
    return this.withHandle(session, capability, signal, async (handle, live) => {
      const resolved = resolveSandboxPath(dir, handle.workspace ?? SANDBOX_WORKSPACE);
      if (!handle.listFiles)
        return {
          kind: "failed" as const,
          code: "sandbox.unsupported",
          message: `The ${live.backend.name} backend cannot list files`,
        };
      const listing = await handle.listFiles(resolved, maxEntries);
      return listing === undefined
        ? { kind: "missing" as const, path: resolved }
        : { kind: "listed" as const, path: resolved, listing };
    });
  }

  /** Runs `use` on the session's sandbox in its queue, starting it first when it is stopped. */
  private async withHandle<T>(
    session: SandboxSessionRef,
    capability: CapabilityManifest,
    signal: AbortSignal,
    use: (handle: SandboxHandle, live: Live) => Promise<T>
  ): Promise<T | Extract<SandboxToolOutcome, { kind: "failed" }>> {
    const prepared = await this.prepare(session, capability);
    if ("kind" in prepared) return prepared;
    const { live, spec } = prepared;
    const task = live.tail.then(async () => {
      if (signal.aborted) throw new Error("Turn cancelled");
      if (this.closing) throw new Error("Runtime is shutting down");
      live.active += 1;
      try {
        if (!live.handle) {
          try {
            live.handle = await this.open(live, session, spec);
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "sandbox.start_failed",
              message: `The sandbox could not start: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        const unmounted = await this.mountSkills(live, live.handle, session, signal);
        if (unmounted) return unmounted;
        return await use(live.handle, live);
      } finally {
        live.active -= 1;
        live.lastUsedAt = Date.now();
      }
    });
    live.tail = task.catch(() => undefined);
    return task;
  }

  /** The session's live sandbox entry and spec, or why it cannot run here. */
  private async prepare(
    session: SandboxSessionRef,
    capability: CapabilityManifest
  ): Promise<{ live: Live; spec: SandboxSpec } | Extract<SandboxToolOutcome, { kind: "failed" }>> {
    const selection = await this.ready;
    const backend = selection.backend;
    if (!backend)
      return {
        kind: "failed",
        code: "sandbox.unavailable",
        message: `No sandbox is available: ${selection.reason}. Run \`npx nylorun doctor sandbox\` for options.`,
      };
    const key = this.keyFor(session);
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
      live = {
        sessionId: session.id,
        ...(session.sandboxId === undefined ? {} : { sandboxId: session.sandboxId }),
        backend,
        idleMs: idleMsOf(capability.sandbox),
        active: 0,
        lastUsedAt: Date.now(),
        tail: Promise.resolve(),
        skills: new Map(),
      };
      this.live.set(key, live);
    }
    return { live, spec };
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
        const record = await this.record(spec.key, live, session.id, spec.image, "stopped");
        await this.options.emit(
          session.id,
          session.activeTurnId,
          "sandbox.state",
          { state: "stopped", backend: live.backend.name, error: message },
          { record, ...claimOf(session) }
        );
        // Nothing ran yet, so a failed start is a definite outcome, not an uncertain one.
        return {
          kind: "failed",
          code: "sandbox.start_failed",
          message: `The sandbox could not start on ${live.backend.name} (image ${spec.image ?? "the backend's default"}): ${message}`,
        };
      }
    }
    const unmounted = await this.mountSkills(live, live.handle, session, signal);
    if (unmounted) return unmounted;
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
      await this.options.emit(
        session.id,
        session.activeTurnId,
        "sandbox.exec",
        {
          tool: toolName,
          ...report,
          ...(report.command ? { command: report.command.slice(0, 500) } : {}),
          outcome: outcome.kind,
          ...(outcome.kind === "failed" ? { code: outcome.code } : {}),
          durationMs: Date.now() - started,
        },
        claimOf(session)
      );
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

  /**
   * Mounts the session's skills the workspace does not hold as they are: on a handle just opened
   * all of them, later only those another session brought or changed. A failed outcome when
   * one cannot be mounted; nothing is marked mounted then, so the next call tries again.
   */
  private async mountSkills(
    live: Live,
    handle: SandboxHandle,
    session: SandboxSessionRef,
    signal: AbortSignal
  ): Promise<Extract<SandboxToolOutcome, { kind: "failed" }> | undefined> {
    const read = this.options.definitionFile;
    if (!read) return undefined;
    for (const [name, files] of sandboxSkillsOf(session.manifest)) {
      const signature = skillSignature(files);
      if (live.skills.get(name) === signature) continue;
      try {
        await mountSkill(handle, name, files, (sha256) => read(sha256, session), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        live.skills.delete(name);
        return {
          kind: "failed",
          code: "sandbox.skills_unavailable",
          message: `The files of skill '${name}' could not be put in the sandbox: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      live.skills.set(name, signature);
    }
    return undefined;
  }

  private async open(live: Live, session: SandboxSessionRef, spec: SandboxSpec): Promise<SandboxHandle> {
    const existing = await this.options.records.get(spec.key);
    const payload = {
      backend: live.backend.name,
      isolation: live.backend.isolation,
      image: spec.image,
      network: describeNetwork(spec.network),
    };
    const creating = await this.record(spec.key, live, session.id, spec.image, "creating", existing);
    await this.options.emit(
      session.id,
      session.activeTurnId,
      "sandbox.state",
      { state: "creating", ...payload, ...(existing ? { reattach: true } : {}) },
      { record: creating, ...claimOf(session) }
    );
    const handle = await live.backend.open(spec);
    // A handle opened afresh holds no skills this manager knows of.
    live.skills.clear();
    const running = await this.record(spec.key, live, session.id, spec.image, "running", existing);
    await this.options.emit(
      session.id,
      session.activeTurnId,
      "sandbox.state",
      {
        state: "running",
        ...payload,
        ...(existing && handle.created
          ? { lost: true, note: "The sandbox was gone and was created again; its earlier files are lost." }
          : {}),
      },
      { record: running, ...claimOf(session) }
    );
    return handle;
  }

  private async stop(key: string, live: Live) {
    const handle = live.handle;
    if (!handle) return;
    live.handle = undefined;
    try {
      await handle.stop();
    } finally {
      const record = await this.record(key, live, live.sessionId, undefined, "stopped");
      await this.options.emit(
        live.sessionId,
        null,
        "sandbox.state",
        { state: "stopped", backend: live.backend.name },
        { record }
      );
    }
  }

  private async record(
    key: string,
    live: Live,
    sessionId: string,
    image: string | undefined,
    state: SandboxState,
    known?: SandboxRecord
  ): Promise<SandboxRecord> {
    const now = new Date().toISOString();
    const existing = known ?? (await this.options.records.get(key));
    const record: SandboxRecord = {
      key,
      sessionId,
      ...(live.sandboxId === undefined ? {} : { sandboxId: live.sandboxId }),
      backend: live.backend.name,
      image: image ?? existing?.image ?? "",
      state,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.options.records.put(record);
    return record;
  }

  /** The sandbox record for a session, if one was ever created. */
  status(sessionId: string): Promise<SandboxRecord | undefined> {
    return this.options.records.get(this.keyOf(sessionId));
  }

  /**
   * Deletes sandbox resource `sandboxId`'s workspace, its files and its compute record, after
   * any command queued on it. Called once the resource is deleted.
   */
  async removeSandbox(sandboxId: string): Promise<void> {
    await this.remove(this.sandboxKeyOf(sandboxId));
  }

  /** Deletes the workspace `key`, its files and its record, after any command queued on it. */
  async remove(key: string): Promise<void> {
    const live = this.live.get(key);
    if (live) {
      await live.tail.catch(() => undefined);
      live.handle = undefined;
      this.live.delete(key);
    }
    const { backend } = await this.ready;
    if (backend) await backend.remove(key);
    await this.options.records.delete(key);
  }

  /**
   * Delete workspaces this Runtime owns whose owner is gone: a session's when `sessionExists`
   * says the session is gone, a sandbox resource's when `sandboxExists` says the resource is.
   */
  async reconcile(
    sessionExists: (sessionId: string) => boolean | Promise<boolean>,
    sandboxExists: (sandboxId: string) => boolean | Promise<boolean>
  ): Promise<void> {
    const { backend } = await this.ready;
    if (!backend) return;
    for (const key of await backend.list(this.prefix)) {
      const record = await this.options.records.get(key);
      if (record) {
        const kept =
          record.sandboxId === undefined
            ? await sessionExists(record.sessionId)
            : await sandboxExists(record.sandboxId);
        if (kept) continue;
      }
      await this.remove(key);
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

function claimOf(session: SandboxSessionRef): { claim?: string } {
  return session.claim === undefined ? {} : { claim: session.claim };
}
