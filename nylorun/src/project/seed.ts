import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A model credential as `PUT /v1/tenant/model` takes it (`auth`); OAuth fields pass through. */
type ModelCredential =
  | { type: "api_key"; key: string }
  | ({ type: "oauth" } & Record<string, unknown>);

interface SeededModel {
  provider: string;
  model: string;
  baseUrl?: string;
  auth: ModelCredential;
}

export interface SeedResult {
  /** Settings the seed set, and the ones the Tenant already had. */
  applied: string[];
  kept: string[];
  /** `provider/model` stored in the Tenant's vault. */
  model?: string;
}

/**
 * The Project's `.env` as a value map. It is never applied to this process or written back:
 * a Project's `.env` never configures the Host.
 */
export function readProjectEnv(projectRoot: string): Record<string, string> {
  const file = join(projectRoot, ".env");
  try {
    if (!statSync(file).isFile()) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8"))))
      if (value !== undefined) result[key] = value;
    return result;
  } catch {
    return {};
  }
}

function modelFromEnv(env: Readonly<Record<string, string>>, projectRoot: string): SeededModel | undefined {
  const provider = env.MODEL_PROVIDER?.trim();
  const model = env.MODEL?.trim();
  if (!provider || !model) return undefined;
  const baseUrl = env.MODEL_PROVIDER_BASE_URL?.trim();
  const base = { provider, model, ...(baseUrl ? { baseUrl } : {}) };
  const key = env.MODEL_PROVIDER_API_KEY;
  if (key) return { ...base, auth: { type: "api_key", key } };
  for (const relative of [".nylorun/auth.json", ".env/auth.json"]) {
    try {
      const all = JSON.parse(readFileSync(join(projectRoot, relative), "utf8")) as Record<
        string,
        ModelCredential | undefined
      >;
      const credential = all[provider];
      if (credential?.type === "api_key" || credential?.type === "oauth")
        return { ...base, auth: credential };
    } catch {
      /* absent */
    }
  }
  return undefined;
}

async function call(
  fetch: FetchLike,
  url: string,
  managementKey: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...(init.method ? { method: init.method } : {}),
    headers: {
      authorization: `Bearer ${managementKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}${
        typeof body.message === "string" ? `: ${body.message}` : ""
      }`,
    );
  return body;
}

/**
 * Seed a new Project's Tenant from the Project's `.env`: the sandbox backend
 * (`NYLORUN_SANDBOX=auto|virtual`, `PUT /v1/tenant/config/seed`, which keeps settings the
 * Tenant has) and the model credential (`MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`,
 * `MODEL_PROVIDER_BASE_URL`, or `.nylorun/auth.json`), stored in the Tenant's vault unless the
 * Tenant has a model or `NYLORUN_DEV_MODEL=fixture`.
 */
export async function seedTenant(input: {
  fetch: FetchLike;
  runtimeUrl: string;
  /** The Project's management key: seeding is the Management API's. */
  managementKey: string;
  projectRoot: string;
}): Promise<SeedResult> {
  const env = readProjectEnv(input.projectRoot);
  const base = input.runtimeUrl.replace(/\/$/, "");
  const result: SeedResult = { applied: [], kept: [] };

  const sandbox = env.NYLORUN_SANDBOX?.trim();
  if (sandbox === "auto" || sandbox === "virtual") {
    const body = (await call(input.fetch, `${base}/v1/tenant/config/seed`, input.managementKey, {
      method: "PUT",
      body: { requestId: randomUUID(), sandbox: { backend: sandbox } },
    })) as { applied?: unknown; kept?: unknown };
    if (Array.isArray(body.applied)) result.applied = body.applied.map(String);
    if (Array.isArray(body.kept)) result.kept = body.kept.map(String);
  }

  if (env.NYLORUN_DEV_MODEL?.trim() === "fixture") return result;
  const seeded = modelFromEnv(env, input.projectRoot);
  if (!seeded) return result;
  const current = (await call(input.fetch, `${base}/v1/tenant/model`, input.managementKey)) as {
    configured?: unknown;
  };
  if (current.configured === true) {
    result.kept.push("model");
    return result;
  }
  await call(input.fetch, `${base}/v1/tenant/model`, input.managementKey, {
    method: "PUT",
    body: {
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: seeded.provider,
      model: seeded.model,
      ...(seeded.baseUrl ? { baseUrl: seeded.baseUrl } : {}),
      auth: seeded.auth,
    },
  });
  result.model = `${seeded.provider}/${seeded.model}`;
  return result;
}
