/**
 * Operator keys (F9 I1, Host feature `operator-keys`) as the nylorun commands use them: the
 * Admin API's `/v1/admin/keys` on a local Tenant's operator listener, with its admin key, and
 * the keys nylorun keeps in the Host root (`project`, `cli`). nylorun depends on
 * `@nylorun/core` only, so these are plain requests (`admin.keys` in `@nylorun/admin` makes
 * the same).
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
import type { FetchLike } from "./studio-login.js";

/** Where a local Tenant's Admin API answers, and its admin key. */
export interface AdminEndpoint {
  fetch: FetchLike;
  adminUrl: string;
  adminKey: string;
}

/** The key `nylorun start` gives the projects it links. */
export const PROJECT_KEY_ID = "project";
/** The key nylorun commands use outside a linked project. */
export const CLI_KEY_ID = "cli";

async function adminRequest(
  admin: AdminEndpoint,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await admin.fetch(`${admin.adminUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${admin.adminKey}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliError(
      `The Admin API at ${admin.adminUrl} did not answer ${method} ${path} (${
        error instanceof Error ? error.message : String(error)
      }).`,
      7,
    );
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

function refused(method: string, path: string, answer: { status: number; body: Record<string, unknown> }): CliError {
  const message = typeof answer.body.message === "string" ? `: ${answer.body.message}` : "";
  // An older Runtime has no key routes: the Admin API's "Route not found".
  if (answer.status === 404 && answer.body.message === "Route not found")
    return new CliError(
      `The Runtime does not serve operator keys (Host feature operator-keys). Update it: npx nylorun@latest start.`,
      1,
    );
  return new CliError(`${method} ${path} returned ${answer.status}${message}`, 1);
}

const keyPath = (id: string) => `/v1/admin/keys/${encodeURIComponent(id)}`;

/** Creates key `id` or rotates it; the answer holds the key, this once. */
export async function putOperatorKey(
  admin: AdminEndpoint,
  id: string,
): Promise<PutOperatorKeyResponse> {
  const answer = await adminRequest(admin, "PUT", keyPath(id));
  if (answer.status !== 200 || typeof answer.body.key !== "string")
    throw refused("PUT", keyPath(id), answer);
  return answer.body as unknown as PutOperatorKeyResponse;
}

export async function listOperatorKeys(admin: AdminEndpoint): Promise<OperatorKey[]> {
  const answer = await adminRequest(admin, "GET", "/v1/admin/keys");
  if (answer.status !== 200 || !Array.isArray(answer.body.keys))
    throw refused("GET", "/v1/admin/keys", answer);
  return answer.body.keys as OperatorKey[];
}

/** Deletes key `id`: false when there is none. */
export async function deleteOperatorKey(admin: AdminEndpoint, id: string): Promise<boolean> {
  const answer = await adminRequest(admin, "DELETE", keyPath(id));
  if (answer.status === 200) return true;
  if (answer.status === 404 && answer.body.message === `No key ${id}`) return false;
  throw refused("DELETE", keyPath(id), answer);
}

/**
 * Whether `key` reaches the Tenant API at `runtimeUrl`: one authenticated read
 * (`GET /v1/tenant`). An unknown key is the opaque 404; another answer is an error.
 */
export async function keyAuthenticates(
  fetch: FetchLike,
  runtimeUrl: string,
  key: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${runtimeUrl}/v1/tenant`, {
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
  throw new CliError(`GET ${runtimeUrl}/v1/tenant returned ${response.status}.`, 7);
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
 * The operator key `id` kept in the Host root file `file` (0600): the file's key while it
 * still authenticates, else `adopt` when it does (a key a project already holds), else a new
 * key put through the Admin API and written to the file. One process at a time (`lock`), so
 * concurrent commands share one key instead of rotating each other's.
 */
export async function hostKey(options: {
  admin: AdminEndpoint;
  runtimeUrl: string;
  id: string;
  file: string;
  lock: string;
  adopt?: KeyCredentials;
}): Promise<KeyCredentials & { put: boolean }> {
  const { admin, runtimeUrl, id, file } = options;
  return await withLock(options.lock, async () => {
    const kept = await readCredentialsFile(file);
    if (kept && (await keyAuthenticates(admin.fetch, runtimeUrl, kept.applicationKey)))
      return { ...kept, put: false };
    if (options.adopt && (await keyAuthenticates(admin.fetch, runtimeUrl, options.adopt.applicationKey))) {
      await writeCredentialsFile(file, options.adopt);
      return { ...options.adopt, put: false };
    }
    const put = await putOperatorKey(admin, id);
    const credentials = { applicationKey: put.key, principalId: put.id };
    await writeCredentialsFile(file, credentials);
    return { ...credentials, put: true };
  });
}
