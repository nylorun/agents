import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/agents";
import type { Credential } from "@earendil-works/pi-ai";
import { CliError } from "../errors.js";
import { putHostModel } from "../model/host-model.js";
import type { PromptedModel } from "../model/configure.js";
import { loadProjectEnvironment } from "../environment.js";

export interface SeedOptions {
  hostUrl: string;
  tenantId: string;
  applicationKey: string;
  projectRoot: string;
  /** Pre-loaded env map; when omitted, read `.env` without mutating process.env. */
  env?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Seed the Tenant-level fixture model (`fixtureModel: true`, Host feature
   * `tenant-fixture-model`) and skip the Project's model credential.
   */
  fixtureModel?: boolean;
}

function tenantHeaders(
  applicationKey: string,
  tenantId: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${applicationKey}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

/**
 * Seed non-secret Tenant config via `PUT /v1/tenant/config/seed`.
 * Model secrets go through the model route into the Tenant vault (F3).
 * `.env` is read as a value map only — never written back or applied to process.env.
 */
export async function seedTenantFromProject(
  options: SeedOptions,
): Promise<{ applied: string[]; kept: string[]; model?: string }> {
  const env = options.env ?? loadProjectEnvironment(options.projectRoot);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sandboxRaw = env.NYLORUN_SANDBOX?.trim();
  const sandbox =
    sandboxRaw === "auto" || sandboxRaw === "virtual"
      ? { backend: sandboxRaw }
      : undefined;

  let applied: string[] = [];
  let kept: string[] = [];

  if (sandbox || options.fixtureModel) {
    const response = await fetchImpl(
      `${options.hostUrl.replace(/\/$/, "")}/v1/tenant/config/seed`,
      {
        method: "PUT",
        headers: {
          ...tenantHeaders(options.applicationKey, options.tenantId),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          ...(sandbox ? { sandbox } : {}),
          ...(options.fixtureModel ? { fixtureModel: true } : {}),
        }),
        signal: options.signal ?? AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new CliError(
        `Tenant config seed failed (${response.status}): ${await response
          .text()
          .catch(() => "")}`,
        1,
      );
    }
    const body = (await response.json()) as {
      applied?: string[];
      kept?: string[];
    };
    applied = body.applied ?? [];
    kept = body.kept ?? [];
  }

  // A fixture-model Tenant never calls a real model: its credential stays out of it.
  let model: string | undefined;
  if (!options.fixtureModel && env.NYLORUN_DEV_MODEL?.trim() !== "fixture") {
    const seeded = modelFromEnv(env, options.projectRoot);
    if (seeded) {
      await putHostModel(
        options.hostUrl,
        options.applicationKey,
        seeded,
        options.tenantId,
      );
      model = `${seeded.provider}/${seeded.model}`;
    }
  }

  return { applied, kept, ...(model ? { model } : {}) };
}

function modelFromEnv(
  env: Readonly<Record<string, string>>,
  projectRoot: string,
): PromptedModel | undefined {
  const provider = env.MODEL_PROVIDER?.trim();
  const model = env.MODEL?.trim();
  if (!provider || !model) return undefined;
  const baseUrl = env.MODEL_PROVIDER_BASE_URL?.trim();
  const key = env.MODEL_PROVIDER_API_KEY;
  if (key) {
    return {
      provider,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      auth: { type: "api_key", key },
    };
  }
  for (const relative of [".nylorun/auth.json", ".env/auth.json"]) {
    try {
      const all = JSON.parse(
        readFileSync(join(projectRoot, relative), "utf8"),
      ) as Record<string, Credential>;
      const credential = all[provider];
      if (credential?.type === "api_key" || credential?.type === "oauth") {
        return {
          provider,
          model,
          ...(baseUrl ? { baseUrl } : {}),
          auth: credential,
        };
      }
    } catch {
      /* absent */
    }
  }
  return undefined;
}
