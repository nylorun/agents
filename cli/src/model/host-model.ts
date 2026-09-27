import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/agents";
import { configureProvider, type PromptedModel } from "./configure.js";
import { loadProjectEnvironment } from "../environment.js";

/** Wire shape of GET/PUT `/v1/tenant/model` — local copy so CLI stays off `@nylorun/core`. */
type HostModelView =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly provider: string;
      readonly model: string;
      readonly authType: "api_key" | "oauth";
      readonly baseUrl?: string;
    };

function tenantHeaders(
  serverKey: string,
  tenantId: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${serverKey}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

function resolveTenantId(explicit?: string): string {
  const tenant = explicit?.trim() || process.env.NYLORUN_TENANT?.trim();
  if (!tenant) {
    throw new Error(
      "Set NYLORUN_TENANT (or pass tenant via Project link) before calling Tenant model routes",
    );
  }
  return tenant;
}

export async function getHostModel(
  runtimeUrl: string,
  serverKey: string,
  tenantId?: string,
): Promise<HostModelView> {
  const tenant = resolveTenantId(tenantId);
  const response = await fetch(`${runtimeUrl}/v1/tenant/model`, {
    headers: tenantHeaders(serverKey, tenant),
  });
  if (!response.ok)
    throw new Error(`Runtime model status returned ${response.status}`);
  return response.json() as Promise<HostModelView>;
}

export async function putHostModel(
  runtimeUrl: string,
  serverKey: string,
  model: PromptedModel,
  tenantId?: string,
): Promise<HostModelView> {
  const tenant = resolveTenantId(tenantId);
  const response = await fetch(`${runtimeUrl}/v1/tenant/model`, {
    method: "PUT",
    headers: {
      ...tenantHeaders(serverKey, tenant),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: model.provider,
      model: model.model,
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      auth: model.auth,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  if (!response.ok)
    throw new Error(
      body.message ?? `Runtime rejected the model provider (${response.status})`,
    );
  return body as HostModelView;
}

export async function ensureHostModel(options: {
  runtimeUrl: string;
  serverKey: string;
  tenantId: string;
  root?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<void> {
  const current = await getHostModel(
    options.runtimeUrl,
    options.serverKey,
    options.tenantId,
  );
  if (current.configured) return;
  const env =
    options.env ?? loadProjectEnvironment(options.root ?? process.cwd());
  if (env.NYLORUN_DEV_MODEL?.trim() === "fixture") return;
  const seeded = seedFromEnv(env, options.root ?? process.cwd());
  if (seeded) {
    await putHostModel(
      options.runtimeUrl,
      options.serverKey,
      seeded,
      options.tenantId,
    );
    return;
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompted = await configureProvider({
      root: options.root,
      signal: options.signal,
    });
    await putHostModel(
      options.runtimeUrl,
      options.serverKey,
      prompted,
      options.tenantId,
    );
    return;
  }
  throw new Error(
    "Model provider is not configured. Run nylo configure in a terminal to set it up, or open Studio.",
  );
}

function seedFromEnv(
  env: Readonly<Record<string, string>>,
  root: string,
): PromptedModel | undefined {
  const provider = env.MODEL_PROVIDER?.trim();
  const model = env.MODEL?.trim();
  if (!provider || !model) return undefined;
  const baseUrl = env.MODEL_PROVIDER_BASE_URL?.trim();
  const key = env.MODEL_PROVIDER_API_KEY;
  const auth = key
    ? ({ type: "api_key", key } as const)
    : legacyCredential(root, provider);
  if (!auth) return undefined;
  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    auth,
  };
}

function legacyCredential(
  root: string,
  provider: string,
): Credential | undefined {
  for (const relative of [".nylorun/auth.json", ".env/auth.json"]) {
    try {
      const all = JSON.parse(readFileSync(join(root, relative), "utf8")) as Record<
        string,
        Credential
      >;
      const credential = all[provider];
      if (credential?.type === "api_key" || credential?.type === "oauth")
        return credential;
    } catch {
      /* A project without a legacy credential file is set up interactively. */
    }
  }
}
