/**
 * Backend contract for Runtime-owned sandboxes. Only files under `adapters/sandbox/` implement it
 * and import a substrate SDK; everything else in the Runtime talks to this interface.
 */
import type { SandboxNetworkPreset } from "@nylorun/core/define";

/** `virtual` (just-bash, in process); `local` (the pod sandbox the engine runs in, F7.2). */
export type SandboxBackendName = "virtual" | "local";
/** What separates a sandbox from its host: the Runtime process, or a container boundary. */
export type SandboxIsolation = "process" | "container";

export interface SandboxProbe {
  readonly name: SandboxBackendName;
  readonly available: boolean;
  readonly isolation: SandboxIsolation;
  /** Why the backend is unavailable, or a short description when it is. */
  readonly reason?: string;
  readonly version?: string;
}

/** Egress policy after presets are expanded. Always-blocked ranges are the backend's job. */
export interface ResolvedNetwork {
  readonly preset: SandboxNetworkPreset;
  /** Exact host names allowed over HTTPS/HTTP. */
  readonly hosts: readonly string[];
  /** Domain suffixes such as ".pythonhosted.org", from "*.pythonhosted.org". */
  readonly suffixes: readonly string[];
}

export interface SandboxSpec {
  /** Stable backend name for this sandbox; unique per Runtime scope and session. */
  readonly key: string;
  /** OCI image reference; undefined means the backend's default. */
  readonly image?: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly network: ResolvedNetwork;
}

export interface ExecRequest {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The process was actually stopped (timeout or cancellation). */
  readonly killed: boolean;
  readonly timedOut: boolean;
}

export interface SandboxHandle {
  /** The directory tools run in and resolve relative paths against. Default: `/workspace`. */
  readonly workspace?: string;
  /** The backend had to create the sandbox afresh, so files from an earlier run are gone. */
  readonly created?: boolean;
  exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
  /** Returns undefined when the file does not exist. */
  readFile(path: string): Promise<string | undefined>;
  /**
   * The file's bytes, or undefined when it does not exist; refuses one larger than `maxBytes`
   * (`SandboxFileTooLargeError`). For `save_artifact`, which keeps binary files intact.
   */
  readBytes?(path: string, maxBytes: number): Promise<Uint8Array | undefined>;
  /**
   * The regular files under directory `dir`, recursively, with paths relative to it (`/`-
   * separated) in path order; symbolic links are skipped. Undefined when `dir` is not a
   * directory. Stops after `maxEntries + 1` files (`truncated`). For the turn-end export (F8.2).
   */
  listFiles?(dir: string, maxEntries: number): Promise<SandboxListing | undefined>;
  /** Text is written as UTF-8, bytes as they are. Parent directories must already exist. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Release compute; files persist. */
  stop(): Promise<void>;
}

/** The files `listFiles` found: paths relative to the directory listed. */
export interface SandboxListing {
  readonly entries: readonly { readonly path: string; readonly size: number }[];
  /** More files than `maxEntries` were found; `entries` holds the first `maxEntries + 1`. */
  readonly truncated: boolean;
}

/** A sandbox file read with `readBytes` is larger than the caller allows. */
export class SandboxFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`${path} is ${size} bytes, more than ${maxBytes}`);
    this.name = "SandboxFileTooLargeError";
  }
}

export interface SandboxBackend {
  readonly name: SandboxBackendName;
  readonly isolation: SandboxIsolation;
  probe(): Promise<SandboxProbe>;
  /** A reason this backend cannot meet the spec, or undefined when it can. */
  unmet(spec: SandboxSpec): string | undefined;
  /** Reattach to an existing sandbox (starting it if stopped) or create a new one. */
  open(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Delete compute and files. Missing sandboxes are ignored. */
  remove(key: string): Promise<void>;
  /** Keys of sandboxes this backend holds whose key starts with the prefix. */
  list(prefix: string): Promise<readonly string[]>;
}
