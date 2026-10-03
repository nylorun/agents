/**
 * Where the SandboxManager keeps its workspaces' compute records (`SandboxRecords`). In core's
 * process the records are the Tenant's `sandboxes` table (`storeSandboxRecords`). A harness
 * process reaches no store (F6.2): it keeps them in a file on its volume
 * (`fileSandboxRecords`), and core keeps its table in step from the harness's `sandbox.state`
 * claims and `workspace.sweep` answers.
 *
 * A workspace's key is `<prefix><16 hex>` for a session's own workspace and
 * `<prefix>sbx-<16 hex>` for a sandbox resource's, where the prefix names the Tenant: core and
 * a harness compute the same keys from the Tenant id.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkspaceRecord } from "@nylorun/core/harness-api";
import type { SessionStore } from "../store/types.js";

export type SandboxState = WorkspaceRecord["state"];

/** A workspace's compute record. */
export type SandboxRecord = WorkspaceRecord;

/** The SandboxManager's records port. */
export interface SandboxRecords {
  get(key: string): Promise<SandboxRecord | undefined>;
  put(record: SandboxRecord): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<SandboxRecord[]>;
  count(): Promise<number>;
}

/** The workspace key prefix of the Tenant `scope`. */
export function workspacePrefix(scope: string): string {
  return `nylorun-${scope}-`;
}

/** The key of session `sessionId`'s own workspace. */
export function sessionWorkspaceKey(scope: string, sessionId: string): string {
  return workspacePrefix(scope) + createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

/**
 * The key of sandbox resource `sandboxId`'s workspace: apart from every session key (16 hex
 * characters after the prefix). The virtual backend keeps it in `<sandboxes>/<key>/workspace`.
 */
export function sandboxWorkspaceKey(scope: string, sandboxId: string): string {
  return `${workspacePrefix(scope)}sbx-${createHash("sha256").update(sandboxId).digest("hex").slice(0, 16)}`;
}

/** The records in the Tenant's `sandboxes` table. */
export function storeSandboxRecords(store: SessionStore): SandboxRecords {
  return {
    get: (key) => store.tx((t) => t.get<SandboxRecord>("sandboxes", key)),
    put: (record) => store.tx((t) => t.put("sandboxes", record.key, record)),
    delete: (key) => store.tx((t) => t.delete("sandboxes", key)),
    list: () => store.tx((t) => t.listSandboxes<SandboxRecord>()),
    count: async () => (await store.tx((t) => t.counts())).sandboxes,
  };
}

/**
 * The records in one JSON file, rewritten whole (to a temporary file, then renamed) after each
 * change. Writes are serialized; a file that cannot be read starts empty.
 */
export function fileSandboxRecords(path: string): SandboxRecords {
  const records = new Map<string, SandboxRecord>();
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { records?: SandboxRecord[] };
    for (const record of stored.records ?? []) records.set(record.key, record);
  } catch {
    /* no file yet, or unreadable: start empty */
  }
  let writing = Promise.resolve();
  const save = () => {
    const body = JSON.stringify({ records: [...records.values()] });
    // A failed write does not stop the next one, which writes everything again.
    writing = writing.catch(() => undefined).then(() => {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, body, { mode: 0o600 });
      renameSync(temporary, path);
    });
    return writing;
  };
  return {
    get: async (key) => records.get(key),
    async put(record) {
      records.set(record.key, record);
      await save();
    },
    async delete(key) {
      if (records.delete(key)) await save();
    },
    list: async () => [...records.values()],
    count: async () => records.size,
  };
}
