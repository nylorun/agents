import { parseFrameAncestors } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";

/**
 * Origins that may embed Studio by default: Babai Desktop's `nylorun` scheme on
 * macOS and Linux, and its WebView2 origin on Windows (Studio §8.9).
 */
export const DEFAULT_STUDIO_FRAME_ANCESTORS = [
  "nylorun://localhost",
  "http://nylorun.localhost",
] as const;

/**
 * Settings in `stack/.env` (mode 0600). Ports and the password persist; the
 * Restate identity public key is derived from `restate-identity.pem`.
 */
export interface StackEnv {
  /** Published Runtime port (loopback): the Tenant API. */
  runtimePort: number;
  /** Published operator port (loopback): the Admin API. */
  adminPort: number;
  /** Published Studio port (loopback). */
  studioPort: number;
  /** Published Restate UI and admin port (loopback). */
  restatePort: number;
  postgresPassword: string;
  /** `publickeyv1_...` of `stack/restate-identity.pem`. */
  restateIdentityKey: string;
  uid: number;
  gid: number;
  /** Absolute Host root on this machine, bind-mounted at /nylorun. */
  hostRoot: string;
  runtimeImage: string;
  studioImage: string;
  /** Exact origins that may frame Studio, separated by spaces (persists). */
  studioFrameAncestors: string;
}

const KEYS = {
  runtimePort: "NYLORUN_PORT",
  adminPort: "NYLORUN_ADMIN_PORT",
  studioPort: "NYLORUN_STUDIO_PORT",
  restatePort: "NYLORUN_RESTATE_PORT",
  postgresPassword: "NYLORUN_POSTGRES_PASSWORD",
  restateIdentityKey: "NYLORUN_RESTATE_IDENTITY_KEY",
  uid: "NYLORUN_UID",
  gid: "NYLORUN_GID",
  hostRoot: "NYLORUN_HOST_ROOT",
  runtimeImage: "NYLORUN_RUNTIME_IMAGE",
  studioImage: "NYLORUN_STUDIO_IMAGE",
  studioFrameAncestors: "NYLORUN_STUDIO_FRAME_ANCESTORS",
} as const satisfies Record<keyof StackEnv, string>;

/** Compose .env values: single quotes keep a value literal (no interpolation). */
function quote(key: string, value: string): string {
  if (/[\r\n']/.test(value))
    throw new CliError(`${key} cannot contain a newline or single quote: ${value}`, 1);
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : `'${value}'`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

export function renderEnvFile(env: StackEnv): string {
  const line = (field: keyof StackEnv) =>
    `${KEYS[field]}=${quote(KEYS[field], String(env[field]))}`;
  return [
    "# Written by `nylorun start`. Mode 0600: holds the Postgres password.",
    "# Ports and the password are kept across starts; images, UID/GID and the",
    "# Host root are refreshed on every start.",
    "",
    "# Published on 127.0.0.1; clients use http://localhost:<port>.",
    line("runtimePort"),
    line("adminPort"),
    line("studioPort"),
    line("restatePort"),
    "",
    line("postgresPassword"),
    "",
    "# Restate signs requests to the Runtime's Worker endpoint with the private",
    "# key in restate-identity.pem; the Runtime accepts only this public key.",
    line("restateIdentityKey"),
    "",
    "# The Runtime and Studio containers run as this user, so files they write",
    "# into the Host root belong to you.",
    line("uid"),
    line("gid"),
    line("hostRoot"),
    "",
    line("runtimeImage"),
    line("studioImage"),
    "",
    "# Exact origins that may show Studio in a frame (Babai Desktop). Kept across",
    "# starts; change with nylorun start --studio-embed-origin <origin>.",
    line("studioFrameAncestors"),
    "",
  ].join("\n");
}

/** Parse KEY=value lines; comments and blank lines are skipped. */
export function parseEnvLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values.set(line.slice(0, index).trim(), unquote(line.slice(index + 1)));
  }
  return values;
}

function port(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** The settings that persist across starts, from an existing .env. */
export interface PersistedStackEnv {
  runtimePort?: number;
  adminPort?: number;
  studioPort?: number;
  restatePort?: number;
  postgresPassword?: string;
  /** Validated origins; absent when the line is missing (an older .env). */
  studioFrameAncestors?: string[];
}

export function parsePersisted(text: string): PersistedStackEnv {
  const values = parseEnvLines(text);
  const out: PersistedStackEnv = {};
  const runtimePort = port(values.get(KEYS.runtimePort));
  if (runtimePort) out.runtimePort = runtimePort;
  const adminPort = port(values.get(KEYS.adminPort));
  if (adminPort) out.adminPort = adminPort;
  const studioPort = port(values.get(KEYS.studioPort));
  if (studioPort) out.studioPort = studioPort;
  const restatePort = port(values.get(KEYS.restatePort));
  if (restatePort) out.restatePort = restatePort;
  const password = values.get(KEYS.postgresPassword);
  if (password && /^[A-Za-z0-9]{16,}$/.test(password))
    out.postgresPassword = password;
  const ancestors = values.get(KEYS.studioFrameAncestors);
  if (ancestors !== undefined) {
    try {
      out.studioFrameAncestors = parseFrameAncestors(ancestors);
    } catch (error) {
      throw new CliError(
        `${KEYS.studioFrameAncestors} in stack/.env: ${error instanceof Error ? error.message : String(error)}`,
        1,
      );
    }
  }
  return out;
}
