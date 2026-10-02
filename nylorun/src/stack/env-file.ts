import { DERIVED_PRINCIPAL_ID_PATTERN } from "@nylorun/core/compatibility";
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
 * Settings in `stack/.env` (mode 0600). Ports, the password and the gates token
 * persist; the Restate identity public key is derived from `restate-identity.pem`.
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
  /** The token the runtime presents to the gateway (`NYLORUN_GATES_TOKEN`), 32 bytes as hex. */
  gatesToken: string;
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
  /** The stack's name: the name of the Tenant its Runtime creates. */
  stackName: string;
  /**
   * Derived principals the Runtime registers on its Tenant, comma-separated (persists);
   * always includes `project`, the Project link's principal.
   */
  derivedPrincipals: string;
}

const KEYS = {
  runtimePort: "NYLORUN_PORT",
  adminPort: "NYLORUN_ADMIN_PORT",
  studioPort: "NYLORUN_STUDIO_PORT",
  restatePort: "NYLORUN_RESTATE_PORT",
  postgresPassword: "NYLORUN_POSTGRES_PASSWORD",
  gatesToken: "NYLORUN_GATES_TOKEN",
  restateIdentityKey: "NYLORUN_RESTATE_IDENTITY_KEY",
  uid: "NYLORUN_UID",
  gid: "NYLORUN_GID",
  hostRoot: "NYLORUN_HOST_ROOT",
  runtimeImage: "NYLORUN_RUNTIME_IMAGE",
  studioImage: "NYLORUN_STUDIO_IMAGE",
  studioFrameAncestors: "NYLORUN_STUDIO_FRAME_ANCESTORS",
  stackName: "NYLORUN_STACK_NAME",
  derivedPrincipals: "NYLORUN_DERIVED_PRINCIPALS",
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
    "# Written by `nylorun start`. Mode 0600: holds the Postgres password and the",
    "# gates token. Ports, the password and the token are kept across starts;",
    "# images, UID/GID and the Host root are refreshed on every start.",
    "",
    "# Published on 127.0.0.1; clients use http://localhost:<port>.",
    line("runtimePort"),
    line("adminPort"),
    line("studioPort"),
    line("restatePort"),
    "",
    line("postgresPassword"),
    "",
    "# The runtime presents this token to the gateway (the Model Gate) with every",
    "# model call.",
    line("gatesToken"),
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
    "# The stack's name, which its Runtime gives the Tenant it creates on the first",
    "# start, and the derived principals it registers on that Tenant (keys derived",
    "# from the admin key; `project` is the Project link's).",
    line("stackName"),
    line("derivedPrincipals"),
    "",
  ].join("\n");
}

/**
 * `NYLORUN_DERIVED_PRINCIPALS`: comma-separated principal ids, as the Runtime accepts them
 * (not `studio`), with `project` first so the Project link's key always works.
 */
export function parseDerivedPrincipals(raw: string, source: string): string[] {
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const id of ids)
    if (!DERIVED_PRINCIPAL_ID_PATTERN.test(id) || id === "studio")
      throw new CliError(
        `${source} has '${id}': each entry must match ${DERIVED_PRINCIPAL_ID_PATTERN} and not be studio.`,
        2,
      );
  return [...new Set(["project", ...ids])];
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
  gatesToken?: string;
  /** Validated origins; absent when the line is missing (an older .env). */
  studioFrameAncestors?: string[];
  derivedPrincipals?: string[];
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
  const gatesToken = values.get(KEYS.gatesToken);
  if (gatesToken && /^[0-9a-f]{64,}$/i.test(gatesToken)) out.gatesToken = gatesToken;
  const principals = values.get(KEYS.derivedPrincipals);
  if (principals !== undefined) {
    try {
      out.derivedPrincipals = parseDerivedPrincipals(principals, `${KEYS.derivedPrincipals} in stack/.env`);
    } catch {
      /* rewritten from the default on the next start */
    }
  }
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
