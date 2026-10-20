/**
 * The Runtime's workload token (#496): a short-lived token a platform gives each installation and
 * rotates through a file, so a gateway trusts the workload instead of a stored key. The file
 * (`NYLORUN_WORKLOAD_TOKEN_FILE`) is read on every use and nothing of it is kept, so a rotation
 * applies to the next request with no restart. A missing, unreadable or empty file fails the
 * request, never sends it unauthenticated.
 *
 * Only the gate side reads it: the model call and the MCP and HTTP tool requests a `workload`
 * credential makes. It never reaches a sandbox (`NYLORUN_*` is not passed to one), the model, an
 * event or a log, and requests scrub it like any credential value. An Agent's writer chooses a
 * credential's `via`, so the token goes only to the origins the operator lists
 * (`NYLORUN_WORKLOAD_TOKEN_ORIGINS`), checked on every use; the model's `baseUrl` is the
 * operator's own.
 */
import { readFile } from "node:fs/promises";

export interface WorkloadTokenSettings {
  /** The token's file (`NYLORUN_WORKLOAD_TOKEN_FILE`). */
  readonly file?: string;
  /** The origins a `workload` credential's `via` may name (`NYLORUN_WORKLOAD_TOKEN_ORIGINS`). */
  readonly origins?: readonly string[];
}

/** Why the workload token could not be used: the message names the setting, never the token. */
export class WorkloadTokenUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkloadTokenUnavailable";
  }
}

let settings: WorkloadTokenSettings = {};

/** Sets where this process reads the workload token and where it may send it (at startup). */
export function useWorkloadToken(next: WorkloadTokenSettings): void {
  settings = { ...next };
}

/** The workload token, read from its file now. */
export async function workloadToken(): Promise<string> {
  const file = settings.file;
  if (file === undefined)
    throw new WorkloadTokenUnavailable("The Runtime has no workload token: set NYLORUN_WORKLOAD_TOKEN_FILE");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new WorkloadTokenUnavailable(`The workload token file ${file} (NYLORUN_WORKLOAD_TOKEN_FILE) cannot be read: ${code}`);
  }
  const token = text.trim();
  if (token.length === 0)
    throw new WorkloadTokenUnavailable(`The workload token file ${file} (NYLORUN_WORKLOAD_TOKEN_FILE) is empty`);
  return token;
}

/** Why the workload token may not go to `via`, or undefined when its origin is listed. */
export function workloadOriginRefused(via: string): string | undefined {
  let origin: string;
  try {
    origin = new URL(via).origin;
  } catch {
    return `${via} is not a URL`;
  }
  return (settings.origins ?? []).includes(origin)
    ? undefined
    : `The workload token may not go to ${origin}: list it in NYLORUN_WORKLOAD_TOKEN_ORIGINS`;
}
