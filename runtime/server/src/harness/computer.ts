/**
 * The computer (`--service computer`, ADR-149): the engine in an Agent Substrate actor when every
 * harness runs outside the sandbox. It runs no loop, joins nothing and dials nothing to the
 * Runtime. It serves the sandbox handle (`SandboxHandle`: commands, files, listings) on
 * `NYLORUN_COMPUTER_PORT` (8080), which the sandbox gateway reaches through Substrate's router
 * (ADR-148), and runs each command as the `local` backend does: the image's shell in `/workspace`,
 * its own process group, the trust variables pointing at a bundle with Substrate's egress CA.
 *
 * Every route but `GET /ready` (the template's wake-up probe) needs `x-nylorun-ticket`: a compact
 * JWS core signs with Ed25519, checked against `NYLORUN_COMPUTER_TICKET_KEY` (the public half the
 * template carries), with `aud: "nylorun-computer"`, `exp` ahead, and `sub` this actor's name
 * (`NYLORUN_COMPUTER_NAME_FILE`), so a router client other than the gateway can't command it.
 *
 * Commands are a start and attaches (ADR-148 decision 5): `POST /v1/exec` starts command `id`, or
 * joins it while it runs, and answers within `waitMs` (at most 50 s) with `{state: "running"}` or
 * `{state: "done", result}`; `POST /v1/exec/{id}/attach` waits again. A command's result is kept 10
 * minutes after it ends. After a drain, the next attach reaches this process on the new worker, its
 * commands moved with the memory snapshot. SIGTERM on Substrate means the worker is stopping: the
 * engine keeps running, so the sandboxes service can suspend it.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rootCertificates } from "node:tls";
import { join } from "node:path";
import { SANDBOX_WORKSPACE } from "@nylorun/core/define";
import { createHostLogger } from "../host/logger.js";
import { localBackend } from "../adapters/sandbox/local.js";
import { SandboxFileTooLargeError, type ExecResult, type SandboxHandle } from "../sandbox/types.js";
import { TRUST_VARIABLES } from "./pod.js";
import { RUNTIME_VERSION } from "../version.js";

export interface ComputerServiceConfig {
  readonly port: number;
  /** The ticket key's public half, SPKI PEM. */
  readonly ticketKey: string;
  /** The file holding this actor's name (Substrate's actorMetadata). */
  readonly nameFile: string;
  /** The engine's own dir on the durable disk (`/harness`). */
  readonly root: string;
  /** Substrate's egress CA, which commands trust for hosts whose keys the egress adds. */
  readonly egressCaFile?: string;
  /** On Agent Substrate: SIGTERM means the worker is stopping, not that the engine should. */
  readonly substrate: boolean;
}

/** The ticket audience. */
export const COMPUTER_AUDIENCE = "nylorun-computer";
/** The longest a start or an attach waits before it answers `running`. */
export const MAX_WAIT_MS = 50_000;
/** How long a command's result is kept after it ends. */
const KEEP_MS = 10 * 60_000;

/** Checks a ticket; the claims, or why it fails. */
export function checkTicket(
  token: string | undefined,
  key: KeyObject,
  subject: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "no ticket" };
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string };
    if (header.alg !== "EdDSA") return { ok: false, reason: "alg" };
    const signed = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
    if (!signed) return { ok: false, reason: "signature" };
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      aud?: string;
      sub?: string;
      exp?: number;
    };
    if (claims.aud !== COMPUTER_AUDIENCE) return { ok: false, reason: "audience" };
    if (claims.sub !== subject) return { ok: false, reason: "subject" };
    if (typeof claims.exp !== "number" || now / 1000 >= claims.exp) return { ok: false, reason: "expired" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

interface Command {
  readonly done: Promise<ExecResult>;
  readonly controller: AbortController;
  result?: ExecResult;
  error?: string;
  endedAt?: number;
}

export interface ComputerExecRequest {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly waitMs?: number;
}

export type ComputerExecAnswer =
  | { readonly state: "running" }
  | { readonly state: "done"; readonly result: ExecResult }
  | { readonly state: "failed"; readonly message: string };

/** The commands a computer runs, by id: start, join, attach, cancel. */
export class ComputerCommands {
  private readonly commands = new Map<string, Command>();

  constructor(private readonly handle: Pick<SandboxHandle, "exec">) {}

  start(request: ComputerExecRequest): Promise<ComputerExecAnswer> {
    this.prune();
    let command = this.commands.get(request.id);
    if (!command) {
      const controller = new AbortController();
      const done = this.handle.exec(
        {
          command: request.command,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          ...(request.env ? { env: request.env } : {}),
        },
        controller.signal,
      );
      const created: Command = { done, controller };
      done.then(
        (result) => {
          created.result = result;
          created.endedAt = Date.now();
        },
        (error: unknown) => {
          created.error = error instanceof Error ? error.message : String(error);
          created.endedAt = Date.now();
        },
      );
      this.commands.set(request.id, created);
      command = created;
    }
    return this.wait(command, request.waitMs);
  }

  /** Undefined when the computer doesn't know the command. */
  attach(id: string, waitMs?: number): Promise<ComputerExecAnswer> | undefined {
    const command = this.commands.get(id);
    return command ? this.wait(command, waitMs) : undefined;
  }

  cancel(id: string): boolean {
    const command = this.commands.get(id);
    command?.controller.abort(new Error("Cancelled"));
    return command !== undefined;
  }

  private async wait(command: Command, waitMs = MAX_WAIT_MS): Promise<ComputerExecAnswer> {
    const ms = Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
    try {
      await Promise.race([command.done.catch(() => undefined), late]);
    } finally {
      clearTimeout(timer);
    }
    if (command.result) return { state: "done", result: command.result };
    if (command.error !== undefined) return { state: "failed", message: command.error };
    return { state: "running" };
  }

  private prune(now = Date.now()): void {
    for (const [id, command] of this.commands)
      if (command.endedAt !== undefined && now - command.endedAt > KEEP_MS) this.commands.delete(id);
  }
}

/** Writes the trust bundle commands use (the public roots, then Substrate's egress CA). */
function trustEnvironment(root: string, egressCaFile: string | undefined): Record<string, string> {
  if (!egressCaFile) return {};
  let ca: string;
  try {
    ca = readFileSync(egressCaFile, "utf8");
  } catch {
    return {};
  }
  const bundle = join(root, "egress-ca-bundle.pem");
  writeFileSync(bundle, `${rootCertificates.join("\n")}\n${ca}\n`, { mode: 0o644 });
  return Object.fromEntries(TRUST_VARIABLES.map((name) => [name, bundle]));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function failure(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

/** The routes, on a handle (tests give their own). */
export function computerHandler(options: {
  readonly handle: SandboxHandle;
  readonly key: KeyObject;
  readonly name: string;
  readonly ready: () => boolean;
  readonly now?: () => number;
}) {
  const commands = new ComputerCommands(options.handle);
  const workspace = options.handle.workspace ?? SANDBOX_WORKSPACE;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://computer");
    try {
      if (request.method === "GET" && url.pathname === "/ready") {
        if (options.ready()) send(response, 200, { status: "ok", version: RUNTIME_VERSION });
        else failure(response, 503, "not_ready", `${workspace} is not writable`);
        return;
      }
      const ticket = request.headers["x-nylorun-ticket"];
      const checked = checkTicket(
        Array.isArray(ticket) ? ticket[0] : ticket,
        options.key,
        options.name,
        options.now?.() ?? Date.now(),
      );
      if (!checked.ok) return failure(response, 401, "unauthorized", `Ticket refused: ${checked.reason}`);
      const path = url.searchParams.get("path") ?? "";
      if (request.method === "GET" && url.pathname === "/v1/info")
        return send(response, 200, { workspace, diskRoots: options.handle.diskRoots ?? { workspace }, version: RUNTIME_VERSION });
      if (request.method === "POST" && url.pathname === "/v1/exec") {
        const exec = (await body(request)) as ComputerExecRequest;
        if (typeof exec.id !== "string" || typeof exec.command !== "string" || typeof exec.timeoutMs !== "number")
          return failure(response, 400, "invalid_request", "id, command and timeoutMs are required");
        return send(response, 200, await commands.start({ ...exec, cwd: exec.cwd || workspace }));
      }
      const attach = /^\/v1\/exec\/([^/]+)\/(attach|cancel)$/.exec(url.pathname);
      if (request.method === "POST" && attach) {
        const id = decodeURIComponent(attach[1]!);
        if (attach[2] === "cancel")
          return send(response, commands.cancel(id) ? 200 : 404, { cancelled: true });
        const { waitMs } = (await body(request)) as { waitMs?: number };
        const answer = commands.attach(id, waitMs);
        if (!answer) return failure(response, 404, "unknown_command", `This computer doesn't know command ${id}`);
        return send(response, 200, await answer);
      }
      if (url.pathname === "/v1/files") {
        if (!path.startsWith("/")) return failure(response, 400, "invalid_request", "path must be absolute");
        if (request.method === "GET") {
          const max = Number(url.searchParams.get("maxBytes") ?? "0") || Number.MAX_SAFE_INTEGER;
          const bytes = await options.handle.readBytes!(path, max);
          if (bytes === undefined) return failure(response, 404, "not_found", `${path} does not exist`);
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
          response.end(bytes);
          return;
        }
        if (request.method === "PUT") {
          await options.handle.writeFile(path, request as AsyncIterable<Uint8Array>);
          return send(response, 200, { written: true });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/list") {
        const dir = url.searchParams.get("dir") ?? "";
        const max = Number(url.searchParams.get("maxEntries") ?? "10000");
        const listed = await options.handle.listFiles!(dir, max);
        if (!listed) return failure(response, 404, "not_found", `${dir} is not a directory`);
        return send(response, 200, listed);
      }
      failure(response, 404, "not_found", `No route ${request.method} ${url.pathname}`);
    } catch (error) {
      if (error instanceof SandboxFileTooLargeError)
        return failure(response, 413, "too_large", error.message);
      if (response.headersSent) return void response.destroy();
      failure(response, 500, "computer_error", error instanceof Error ? error.message : String(error));
    }
  };
}

/** Runs the computer until the process ends. */
export async function runComputer(
  config: ComputerServiceConfig,
  baseline: Readonly<Record<string, string>>,
): Promise<void> {
  const logger = createHostLogger();
  const trust = trustEnvironment(config.root, config.egressCaFile);
  const backend = localBackend({ env: baseline, proxyEnv: () => trust, harnessRoot: config.root });
  const handle = await backend.open({
    key: "computer",
    cpus: 1,
    memoryMiB: 1024,
    network: { preset: "none", hosts: [], suffixes: [] },
  });
  const name = readFileSync(config.nameFile, "utf8").trim();
  const key = createPublicKey(config.ticketKey);
  const ready = () => {
    try {
      accessSync(handle.workspace ?? SANDBOX_WORKSPACE, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const server = createServer((request, response) => void computerHandler({ handle, key, name, ready })(request, response));
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => resolve());
  });
  logger.info("computer_ready", { name, port: config.port, version: RUNTIME_VERSION });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      // On Agent Substrate, SIGTERM means the worker pod is stopping: the actor has 30 minutes to
      // be suspended, and the sandboxes service suspends it (Substrate's eviction contract).
      if (signal === "SIGTERM" && config.substrate) {
        logger.info("computer_worker_stopping", { name });
        return;
      }
      if (stopping) return;
      stopping = true;
      server.close();
      process.exit(0);
    });
}
