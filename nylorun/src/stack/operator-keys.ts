/**
 * A local Tenant's keys as the nylorun commands use them: `nylorun-operate keys … --json` in its
 * runtime container (`docker compose exec`), and the keys nylorun keeps in the Host root
 * (`project` and `project-management`, `cli` and `cli-management`). nylorun depends on
 * `@nylorun/core` only, so key probes are plain requests.
 */
import { open, rm, stat } from "node:fs/promises";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { OperatorKey, PutOperatorKeyResponse } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import {
  readCredentialsFile,
  writeCredentialsFile,
  type KeyCredentials,
} from "../project/link.js";
import type { DockerResult } from "./docker.js";
import type { FetchLike } from "./studio-login.js";

/** A local Tenant: `nylorun-operate` in its runtime container, and a fetch to probe keys. */
export interface OperateEndpoint {
  fetch: FetchLike;
  /** Runs `nylorun-operate <args>` in the runtime container. */
  operate(args: readonly string[]): Promise<DockerResult>;
}

/** The keys `nylorun start` gives the projects it links (and `-management`). */
export const PROJECT_KEY_ID = "project";
/** The keys nylorun commands use outside a linked project (and `-management`). */
export const CLI_KEY_ID = "cli";

/** `nylorun-operate keys <args> --json`: its JSON answer, or exit 1 refused, 2 Tenant not open. */
async function operateKeys(endpoint: OperateEndpoint, args: readonly string[]): Promise<unknown> {
  const result = await endpoint.operate(["keys", ...args, "--json"]);
  const message = result.stderr.trim();
  if (result.code === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      /* below */
    }
  }
  if (result.code === 1) throw new CliError(message, 1);
  if (result.code === 2) throw new CliError(`The Tenant is not open: ${message}`, 7);
  throw new CliError(
    `nylorun-operate keys ${args.join(" ")} failed (exit ${result.code})${message ? `: ${message}` : ""}`,
    1,
  );
}

/** Creates key `id` with `role` or rotates it; the answer holds the key, this once. */
export async function putOperatorKey(
  endpoint: OperateEndpoint,
  id: string,
  role: "application" | "management",
): Promise<PutOperatorKeyResponse> {
  return (await operateKeys(endpoint, ["put", id, "--role", role])) as PutOperatorKeyResponse;
}

export async function listOperatorKeys(endpoint: OperateEndpoint): Promise<OperatorKey[]> {
  return ((await operateKeys(endpoint, ["list"])) as { keys: OperatorKey[] }).keys;
}

/** Deletes key `id`: false when there is none. */
export async function deleteOperatorKey(endpoint: OperateEndpoint, id: string): Promise<boolean> {
  return ((await operateKeys(endpoint, ["rm", id])) as { deleted: boolean }).deleted;
}

/**
 * Whether `key` reaches the Tenant at `runtimeUrl`: one authenticated read (`GET /v1/me`, which
 * every key reaches). An unknown key is the opaque 404; another answer is an error.
 */
export async function keyAuthenticates(
  fetch: FetchLike,
  runtimeUrl: string,
  key: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${runtimeUrl}/v1/me`, {
      headers: {
        authorization: `Bearer ${key}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CliError(
      `The Runtime at ${runtimeUrl} did not answer (${error instanceof Error ? error.message : String(error)}).`,
      7,
    );
  }
  await response.arrayBuffer().catch(() => undefined);
  if (response.ok) return true;
  if (response.status === 401 || response.status === 403 || response.status === 404) return false;
  throw new CliError(`GET ${runtimeUrl}/v1/me returned ${response.status}.`, 7);
}

const LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this was left by a process that died. */
const LOCK_STALE_MS = 60_000;

/** Runs `fn` holding the lock file `path` (created exclusively), so one process puts a key. */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(path).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new CliError(`Another nylorun command holds ${path}. Remove it if none runs.`, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * The keys `id` (application) and `id-management` (management) kept in the Host root file
 * `file` (0600): each of the file's keys while it still authenticates, else `adopt`'s when it
 * does (keys a project already holds), else a new key put through `nylorun-operate`, written to
 * the file. One process at a time (`lock`), so concurrent commands share one key instead of
 * rotating each other's.
 */
export async function hostKey(options: {
  endpoint: OperateEndpoint;
  runtimeUrl: string;
  id: string;
  file: string;
  lock: string;
  adopt?: KeyCredentials;
}): Promise<Required<KeyCredentials>> {
  const { endpoint, runtimeUrl, id, file, adopt } = options;
  const reaches = (key: string | undefined) =>
    key === undefined ? Promise.resolve(false) : keyAuthenticates(endpoint.fetch, runtimeUrl, key);
  return await withLock(options.lock, async () => {
    const kept = await readCredentialsFile(file);
    let application = kept && (await reaches(kept.applicationKey)) ? kept : undefined;
    if (!application && adopt && (await reaches(adopt.applicationKey))) application = adopt;
    if (!application) {
      const put = await putOperatorKey(endpoint, id, "application");
      application = { applicationKey: put.key, principalId: put.id };
    }
    let management = (await reaches(kept?.management?.key)) ? kept!.management : undefined;
    if (!management && (await reaches(adopt?.management?.key))) management = adopt!.management;
    if (!management) {
      const put = await putOperatorKey(endpoint, `${id}-management`, "management");
      management = { key: put.key, principalId: put.id };
    }
    const credentials = {
      applicationKey: application.applicationKey,
      principalId: application.principalId,
      management,
    };
    if (JSON.stringify(kept) !== JSON.stringify(credentials))
      await writeCredentialsFile(file, credentials);
    return credentials;
  });
}
