/**
 * Computer backend (ADR-149, ADR-150): a pod Agent's sandbox on Agent Substrate, reached through
 * the sandbox gateway and Substrate's router (ADR-148). Its handle sends each operation to the
 * computer's engine (`harness/computer.ts`) with a ticket core signs: `open` (a harness asks core
 * with `computer.open`; core in process) wakes the computer, runs its disk's setup, and answers
 * the gateway URL for this computer, the ticket and when it expires. A ticket is asked for again
 * a minute before it expires.
 *
 * A command is a start and attaches, each answered within 50 s, under the command's own timeout:
 * a gateway or router that drops a request (a rollout, a drain) is asked again with the same id,
 * and the computer joins the command it already runs. One the computer no longer knows (lost with
 * a crash or a revert) fails the call, saying so.
 *
 * One computer holds one sandbox: every key opens the same handle. Removing it is the Agent's reset
 * or delete (core's pod lifecycle), so `remove` and `list` do nothing here; `stop` does nothing
 * either, as core suspends an idle computer.
 */
import { randomUUID } from "node:crypto";
import { SANDBOX_WORKSPACE } from "@nylorun/core/define";
import {
  SandboxFileTooLargeError,
  type ExecRequest,
  type ExecResult,
  type SandboxBackend,
  type SandboxFileBytes,
  type SandboxHandle,
  type SandboxListing,
  wholeBytes,
} from "../../sandbox/types.js";

/** What `open` answers: where this computer is, and the ticket for it. */
export interface ComputerAccess {
  /** The gateway's URL for this computer, `<gateway>/<sandbox>`. */
  readonly url: string;
  readonly ticket: string;
  /** When the ticket expires (ms since the epoch). */
  readonly expiresAt: number;
}

export interface ComputerBackendOptions {
  readonly open: (signal?: AbortSignal) => Promise<ComputerAccess>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How long a dropped request is asked again for, past the command's own timeout. */
  readonly retryMs?: number;
}

/** A computer refused or failed an operation. */
export class ComputerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

const WAIT_MS = 50_000;
const RENEW_MS = 60_000;

/** The disk roots of every computer (R9, ADR-150). */
export const COMPUTER_DISK_ROOTS = { workspace: SANDBOX_WORKSPACE, harness: "/harness" } as const;

export function computerBackend(options: ComputerBackendOptions): SandboxBackend {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 3 * 60_000;
  let access: ComputerAccess | undefined;
  let opening: Promise<ComputerAccess> | undefined;

  const current = async (signal?: AbortSignal): Promise<ComputerAccess> => {
    if (access && access.expiresAt - now() > RENEW_MS) return access;
    opening ??= options.open(signal).finally(() => (opening = undefined));
    access = await opening;
    return access;
  };

  const call = async (
    method: string,
    path: string,
    init: { body?: BodyInit; json?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> => {
    const at = await current(init.signal);
    const headers: Record<string, string> = { "x-nylorun-ticket": at.ticket };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const response = await http(`${at.url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array) ? { duplex: "half" } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    } as RequestInit);
    if (response.status === 401) access = undefined; // a new ticket next time
    return response;
  };

  const failed = async (response: Response): Promise<ComputerError> => {
    let code = "computer_error";
    let message = `The computer answered ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      // not JSON
    }
    return new ComputerError(response.status, code, message);
  };

  /** Whether a failure is the way's (gateway, router, a computer moving), worth asking again. */
  const transient = (error: unknown) =>
    error instanceof ComputerError ? error.status === 401 || error.status >= 500 : !(error instanceof DOMException && error.name === "AbortError");

  const exec = async (request: ExecRequest, signal: AbortSignal): Promise<ExecResult> => {
    const id = randomUUID();
    const deadline = now() + request.timeoutMs + retryMs;
    let started = false;
    const cancel = () => void call("POST", `/v1/exec/${encodeURIComponent(id)}/cancel`).catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw signal.reason ?? new Error("Turn cancelled");
        try {
          const response = started
            ? await call("POST", `/v1/exec/${encodeURIComponent(id)}/attach`, { json: { waitMs: WAIT_MS }, signal })
            : await call("POST", "/v1/exec", {
                json: { id, command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs, env: request.env ?? {}, waitMs: WAIT_MS },
                signal,
              });
          if (response.status === 404 && started)
            return {
              exitCode: 1,
              stdout: "",
              stderr: "The computer lost this command (it was restarted from its last snapshot).",
              killed: true,
              timedOut: false,
            };
          if (!response.ok) throw await failed(response);
          started = true;
          attempt = 0;
          const answer = (await response.json()) as
            | { state: "running" }
            | { state: "done"; result: ExecResult }
            | { state: "failed"; message: string };
          if (answer.state === "done") return answer.result;
          if (answer.state === "failed") throw new ComputerError(500, "command_failed", answer.message);
        } catch (error) {
          if (!transient(error) || now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * 2 ** attempt)));
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };

  const readBytes = async (path: string, maxBytes: number): Promise<Uint8Array | undefined> => {
    const response = await call("GET", `/v1/files?path=${encodeURIComponent(path)}&maxBytes=${maxBytes}`);
    if (response.status === 404) return undefined;
    if (response.status === 413) {
      const error = await failed(response);
      const size = Number(/is (\d+) bytes/.exec(error.message)?.[1] ?? maxBytes + 1);
      throw new SandboxFileTooLargeError(path, size, maxBytes);
    }
    if (!response.ok) throw await failed(response);
    return new Uint8Array(await response.arrayBuffer());
  };

  const handle: SandboxHandle = {
    workspace: SANDBOX_WORKSPACE,
    diskRoots: COMPUTER_DISK_ROOTS,
    exec,
    async readFile(path) {
      const bytes = await readBytes(path, Number.MAX_SAFE_INTEGER);
      return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
    },
    readBytes,
    async listFiles(dir, maxEntries): Promise<SandboxListing | undefined> {
      const response = await call("GET", `/v1/list?dir=${encodeURIComponent(dir)}&maxEntries=${maxEntries}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failed(response);
      return (await response.json()) as SandboxListing;
    },
    async writeFile(path, content: string | SandboxFileBytes) {
      // A file's chunks are gathered: a skill's file is at most a few megabytes.
      const body = (typeof content === "string" ? content : Buffer.from(await wholeBytes(content))) as unknown as BodyInit;
      const response = await call("PUT", `/v1/files?path=${encodeURIComponent(path)}`, { body });
      if (!response.ok) throw await failed(response);
    },
    async stop() {},
  };

  return {
    name: "computer",
    isolation: "container",
    async probe() {
      return { name: "computer", isolation: "container", available: true, reason: "an Agent Substrate computer" };
    },
    unmet: () => undefined,
    open: async () => {
      await current();
      return handle;
    },
    async remove() {},
    async list() {
      return [];
    },
  };
}
