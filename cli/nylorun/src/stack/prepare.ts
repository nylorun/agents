import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { renderComposeFile } from "./compose-file.js";
import { parseFrameAncestors } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import {
  DEFAULT_STUDIO_FRAME_ANCESTORS,
  parsePersisted,
  renderEnvFile,
  type SandboxStackEnv,
  type StackEnv,
} from "./env-file.js";
import { sandboxesEnabled } from "../sandbox/cluster-file.js";
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

/** Read the persisted Compose settings without writing anything. */
export async function readStackEnv(paths: Pick<StackPaths, "env">) {
  const text = await readText(paths.env);
  return text === undefined ? undefined : parsePersisted(text);
}

/**
 * Write everything `docker compose up` needs under the Host root:
 * host.json, host-credentials.json (0600), docker/compose.yaml,
 * docker/.env (0600) and docker/restate-identity.pem (0600). Ports and the
 * Postgres password persist in .env; the identity key persists in its PEM. The harness token
 * and mode persist too; whether Restate's UI is published is decided on every start.
 */
export async function prepareStack(input: {
  paths: StackPaths;
  /** The Tenant's name and its Compose project. */
  name: string;
  project: string;
  images: StackImages;
  uid: number;
  gid: number;
  /** Recorded in host.json; undefined keeps the recorded version. */
  runtimeVersion: string | undefined;
  ports: PortProbe;
  /** Ports other Tenants keep in their `.env`: never chosen for a port not chosen yet. */
  reserved?: ReadonlySet<number>;
  /**
   * Changes to the origins that may embed Studio: `reset` empties the list (the
   * default), `add` appends (for example a desktop app's dev server).
   */
  studioEmbedOrigins?: { add?: readonly string[]; reset?: boolean };
  /** The measurement id Studio reports page views to; absent when telemetry is off. */
  studioAnalyticsId?: string;
  /**
   * The sandboxes settings (`nylorun sandbox enable`); null removes them (`disable`).
   * Undefined keeps the persisted ones while `sandboxes/cluster.json` exists.
   */
  sandboxes?: SandboxStackEnv | null;
  /** Publish Restate's UI and admin port (`start --restate-ui`); undefined keeps the last start's choice. */
  restateUi?: boolean;
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
    studioPort,
    restatePort,
    postgresPassword: persisted.postgresPassword ?? randomBytes(24).toString("hex"),
    // Kept across starts: a new token would recreate the runtime and gateway containers.
    gatesToken: persisted.gatesToken ?? randomBytes(32).toString("hex"),
    // Kept across starts: a new token would recreate the runtime and harness containers.
    harnessToken: persisted.harnessToken ?? randomBytes(32).toString("hex"),
    harness: persisted.harness ?? "remote",
    restateUi: input.restateUi ?? persisted.restateUi ?? false,
    // Kept across starts: a new key would recreate the runtime, gateway and rustfs containers.
    objectStoreSecretKey: persisted.objectStoreSecretKey ?? randomBytes(32).toString("hex"),
    restateIdentityKey: identity.publicKey,
    uid: input.uid,
    gid: input.gid,
    hostRoot: paths.root,
    runtimeImage: input.images.runtime,
    studioImage: input.images.studio,
    studioFrameAncestors,
    studioAnalyticsId: input.studioAnalyticsId ?? "",
    tenantName: input.name,
  };

  const sandboxes =
    input.sandboxes === null
      ? undefined
      : (input.sandboxes ?? (sandboxesEnabled(paths.root) ? persisted.sandboxes : undefined));
  // The sandboxes image follows the Runtime's, like the runtime image, on every start.
  if (sandboxes) env.sandboxes = { ...sandboxes, image: input.images.sandboxes };

  const { adminKey } = await ensureHostCredentials(paths);
  await ensureVaultKey(paths);
  const host = await writeStackHostConfig(paths, {
    port: runtimePort,
    runtimeVersion: input.runtimeVersion,
  });
  await writeFileMode(paths.env, renderEnvFile(env), 0o600);
  await writeFileMode(
    paths.compose,
    renderComposeFile(input.project, input.name, {
      harness: env.harness,
      ...(env.sandboxes ? { sandboxes: true } : {}),
      ...(env.restateUi ? { restateUi: true } : {}),
      // The trusted issuers, when the operator wrote an identity file; a change takes a restart.
      ...(existsSync(paths.identity) ? { identity: true } : {}),
    }),
    0o644,
  );
  return { env, host, adminKey, firstRun };
}
