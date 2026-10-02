import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { renderComposeFile } from "./compose-file.js";
import { parseFrameAncestors } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import {
  DEFAULT_STUDIO_FRAME_ANCESTORS,
  parseDerivedPrincipals,
  parsePersisted,
  renderEnvFile,
  type StackEnv,
} from "./env-file.js";
import {
  ensureHostCredentials,
  ensureVaultKey,
  ensureHostLayout,
  writeStackHostConfig,
  type HostConfigFile,
} from "./host-files.js";
import type { StackImages } from "./images.js";
import type { StackPaths } from "./paths.js";
import { choosePort, DEFAULT_PORTS, type PortProbe } from "./ports.js";
import { ensureIdentityKey } from "./restate-identity.js";

export interface PreparedStack {
  env: StackEnv;
  host: HostConfigFile;
  adminKey: string;
  /** True when this run chose the ports (first start). */
  firstRun: boolean;
}

async function writeFileMode(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Read the persisted stack settings without writing anything. */
export async function readStackEnv(paths: Pick<StackPaths, "env">) {
  const text = await readText(paths.env);
  return text === undefined ? undefined : parsePersisted(text);
}

/**
 * Write everything `docker compose up` needs under the Host root:
 * host.json, host-credentials.json (0600), docker/compose.yaml,
 * docker/.env (0600) and docker/restate-identity.pem (0600). Ports and the
 * Postgres password persist in .env; the identity key persists in its PEM.
 */
export async function prepareStack(input: {
  paths: StackPaths;
  /** The stack's name (its Tenant's name) and its Compose project. */
  name: string;
  project: string;
  images: StackImages;
  uid: number;
  gid: number;
  /** Recorded in host.json; undefined keeps the recorded version. */
  runtimeVersion: string | undefined;
  ports: PortProbe;
  /** Ports other stacks keep in their `.env`: never chosen for a port not chosen yet. */
  reserved?: ReadonlySet<number>;
  /** `NYLORUN_DERIVED_PRINCIPALS` from the environment of `nylorun start`; else kept. */
  derivedPrincipals?: string;
  /**
   * Changes to the origins that may embed Studio: `reset` goes back to the
   * defaults, `add` appends (for example a desktop app's dev server).
   */
  studioEmbedOrigins?: { add?: readonly string[]; reset?: boolean };
}): Promise<PreparedStack> {
  const { paths } = input;
  await ensureHostLayout(paths);
  const persisted = (await readStackEnv(paths)) ?? {};
  const firstRun = persisted.runtimePort === undefined;

  const taken = new Set<number>();
  const reserved = input.reserved ?? new Set<number>();
  const pick = async (preferred: number, persistedPort: number | undefined) => {
    const avoid = persistedPort === undefined ? new Set([...taken, ...reserved]) : taken;
    const port = await choosePort(input.ports, preferred, persistedPort, avoid);
    taken.add(port);
    return port;
  };
  const runtimePort = await pick(DEFAULT_PORTS.runtime, persisted.runtimePort);
  const adminPort = await pick(DEFAULT_PORTS.admin, persisted.adminPort);
  const studioPort = await pick(DEFAULT_PORTS.studio, persisted.studioPort);
  const restatePort = await pick(DEFAULT_PORTS.restate, persisted.restatePort);

  const identity = await ensureIdentityKey(paths.restateIdentity, writeFileMode);

  let added: string[];
  try {
    added = parseFrameAncestors((input.studioEmbedOrigins?.add ?? []).join(" "));
  } catch (error) {
    throw new CliError(
      `--studio-embed-origin: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  const base =
    input.studioEmbedOrigins?.reset || persisted.studioFrameAncestors === undefined
      ? [...DEFAULT_STUDIO_FRAME_ANCESTORS]
      : persisted.studioFrameAncestors;
  const studioFrameAncestors = [...new Set([...base, ...added])].join(" ");

  const env: StackEnv = {
    runtimePort,
    adminPort,
    studioPort,
    restatePort,
    postgresPassword: persisted.postgresPassword ?? randomBytes(24).toString("hex"),
    // Kept across starts: a new token would recreate the runtime and gateway containers.
    gatesToken: persisted.gatesToken ?? randomBytes(32).toString("hex"),
    restateIdentityKey: identity.publicKey,
    uid: input.uid,
    gid: input.gid,
    hostRoot: paths.root,
    runtimeImage: input.images.runtime,
    studioImage: input.images.studio,
    studioFrameAncestors,
    stackName: input.name,
    derivedPrincipals: (input.derivedPrincipals?.trim()
      ? parseDerivedPrincipals(input.derivedPrincipals, "NYLORUN_DERIVED_PRINCIPALS")
      : (persisted.derivedPrincipals ?? ["project"])
    ).join(","),
  };

  const { adminKey } = await ensureHostCredentials(paths);
  await ensureVaultKey(paths);
  const host = await writeStackHostConfig(paths, {
    port: runtimePort,
    adminPort,
    runtimeVersion: input.runtimeVersion,
  });
  await writeFileMode(paths.env, renderEnvFile(env), 0o600);
  await writeFileMode(paths.compose, renderComposeFile(input.project), 0o644);
  return { env, host, adminKey, firstRun };
}
