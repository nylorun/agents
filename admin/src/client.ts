import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AdminStatusSchema,
  AdminTenantSchema,
  AdminTenantStatusSchema,
  RejectedResponseSchema,
  TenantEnvelopeSchema,
  type AdminStatus,
  type AdminTenant,
  type AdminTenantStatus,
  type TenantEnvelope,
} from "@nylorun/core/contracts";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  checkCompatibility,
  DERIVED_PRINCIPAL_ID_PATTERN,
  newPrincipalId,
  newTenantId,
  type ProtocolRange,
} from "@nylorun/core/compatibility";
import { deriveStudioToken, deriveTenantKey } from "./derived-credentials.js";
import { AdminError } from "./errors.js";

export type AdminSource = "options" | "environment" | "local-host";

export interface ResolvedAdmin {
  url: string;
  key: string;
  source: AdminSource;
  home: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function resolveHome(home?: string): string {
  if (home !== undefined && home.trim() !== "") return resolve(home);
  const fromEnv = env("NYLORUN_HOME");
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(homedir(), ".nylorun"));
}

function connectionMissing(message: string): never {
  throw new AdminError("connection_missing", message);
}

function sourcesTriedMessage(home: string): string {
  return (
    `Tried options (url + key), environment (NYLORUN_ADMIN_URL + NYLORUN_ADMIN_KEY), ` +
    `and local Host settings (host.json + host-credentials.json under ${home}).`
  );
}

function assertCredentialsSafe(path: string): void {
  if (process.platform === "win32") return;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    connectionMissing(
      `host-credentials.json at ${path} is not owned by the current user. ${sourcesTriedMessage(resolve(join(path, "..")))}`,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    connectionMissing(
      `host-credentials.json at ${path} is group- or world-readable; fix permissions (chmod 600). ${sourcesTriedMessage(resolve(join(path, "..")))}`,
    );
  }
}

function readLocalHost(home: string): { url: string; key: string } | undefined {
  const configPath = join(home, "host.json");
  const credentialsPath = join(home, "host-credentials.json");
  let config: unknown;
  let credentials: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  try {
    assertCredentialsSafe(credentialsPath);
    credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch (error) {
    if (error instanceof AdminError) throw error;
    return undefined;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    return undefined;
  }
  const host = (config as { host?: unknown }).host;
  const port = (config as { port?: unknown }).port;
  const adminKey = (credentials as { adminKey?: unknown }).adminKey;
  if (typeof host !== "string" || typeof port !== "number") return undefined;
  if (typeof adminKey !== "string" || !/^[0-9a-f]{64}$/.test(adminKey)) {
    return undefined;
  }
  return { url: `http://${host}:${port}`, key: adminKey };
}

/**
 * Resolve Admin API connection once: options → environment → local Host.
 */
export function resolveAdminConnection(options?: {
  url?: string;
  key?: string;
  home?: string;
}): ResolvedAdmin {
  const home = resolveHome(options?.home);
  const optionUrl = options?.url?.trim() || undefined;
  const optionKey = options?.key?.trim() || undefined;
  if (optionUrl || optionKey) {
    if (!optionUrl || !optionKey) {
      connectionMissing(
        `Incomplete Admin API options: both url and key are required. ${sourcesTriedMessage(home)}`,
      );
    }
    return {
      url: optionUrl.replace(/\/$/, ""),
      key: optionKey,
      source: "options",
      home,
    };
  }

  const envUrl = env("NYLORUN_ADMIN_URL");
  const envKey = env("NYLORUN_ADMIN_KEY");
  if (envUrl || envKey) {
    if (!envUrl || !envKey) {
      connectionMissing(
        `Incomplete Admin API environment: both NYLORUN_ADMIN_URL and NYLORUN_ADMIN_KEY are required. ${sourcesTriedMessage(home)}`,
      );
    }
    return {
      url: envUrl.replace(/\/$/, ""),
      key: envKey,
      source: "environment",
      home,
    };
  }

  const local = readLocalHost(home);
  if (local) {
    return {
      url: local.url.replace(/\/$/, ""),
      key: local.key,
      source: "local-host",
      home,
    };
  }

  connectionMissing(
    `Could not resolve Admin API connection. ${sourcesTriedMessage(home)}`,
  );
}

function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.min !== "number" ||
    typeof record.max !== "number" ||
    !Array.isArray(record.features) ||
    !record.features.every((f) => typeof f === "string")
  ) {
    return undefined;
  }
  return {
    min: record.min,
    max: record.max,
    features: record.features as readonly string[],
  };
}

function hashCredential(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintApplicationKey(): string {
  return randomBytes(32).toString("hex");
}

function throwFromResponse(status: number, body: unknown): never {
  const parsed = RejectedResponseSchema.safeParse(body);
  if (parsed.success) {
    throw new AdminError(parsed.data.code, parsed.data.message, {
      status,
      details: parsed.data.details,
    });
  }
  if (status === 409) {
    throw new AdminError(
      "tenant_conflict",
      `Admin request conflict (${status})`,
      { status, details: body },
    );
  }
  if (status === 404) {
    throw new AdminError("not_found", `Admin request not found (${status})`, {
      status,
      details: body,
    });
  }
  throw new AdminError("not_found", `Admin request failed (${status})`, {
    status,
    details: body,
  });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class AdminClient {
  readonly url: string;
  readonly source: AdminSource;
  private readonly key: string;
  private compatible = false;
  /** Features the Host advertised at the last compatibility check. */
  private features: readonly string[] = [];

  constructor(resolved: ResolvedAdmin) {
    this.url = resolved.url;
    this.source = resolved.source;
    this.key = resolved.key;
  }

  private clearCompatibilityCache(): void {
    this.compatible = false;
  }

  private adminHeaders(init: RequestInit = {}): Headers {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.key}`);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    return headers;
  }

  private async ensureCompatible(signal?: AbortSignal): Promise<void> {
    if (this.compatible) return;
    const response = await fetch(`${this.url}/health`, {
      method: "GET",
      redirect: "error",
      signal,
    });
    const body = await readBody(response);
    if (!response.ok) {
      throwFromResponse(response.status, body);
    }
    const protocol = parseProtocolRange(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).protocol
        : undefined,
    );
    if (!protocol) {
      throw new AdminError(
        "incompatible_host",
        "Host /health did not advertise a protocol range.",
      );
    }
    const result = checkCompatibility(
      { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
      protocol,
    );
    if (!result.ok) {
      const detail =
        result.reason === "version"
          ? `client protocol ${result.client} is outside Host range ${result.host.min}–${result.host.max}`
          : `Host is missing required features: ${result.missing.join(", ")}`;
      throw new AdminError(
        "incompatible_host",
        `Incompatible Host: ${detail}`,
        { details: result },
      );
    }
    this.features = [...protocol.features];
    this.compatible = true;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    options: { retried426?: boolean } = {},
  ): Promise<Response> {
    await this.ensureCompatible(
      init.signal === null ? undefined : init.signal,
    );
    const response = await fetch(this.url + path, {
      ...init,
      headers: this.adminHeaders(init),
      redirect: "error",
    });
    if (response.status === 426) {
      this.clearCompatibilityCache();
      if (!options.retried426) {
        await this.ensureCompatible(
          init.signal === null ? undefined : init.signal,
        );
        return this.request(path, init, { retried426: true });
      }
      const body = await readBody(response);
      const protocol = parseProtocolRange(
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).protocol
          : undefined,
      );
      if (protocol) {
        const result = checkCompatibility(
          { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
          protocol,
        );
        if (!result.ok) {
          throw new AdminError(
            "incompatible_host",
            "Incompatible Host after protocol upgrade challenge.",
            { status: 426, details: result },
          );
        }
      }
      throwFromResponse(426, body);
    }
    return response;
  }

  private async json<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return undefined as T;
    const parsed = await readBody(response);
    if (!response.ok) throwFromResponse(response.status, parsed);
    return parsed as T;
  }

  async status(): Promise<AdminStatus> {
    const body = await this.json<unknown>("/v1/admin/status");
    return AdminStatusSchema.parse(body);
  }

  async listTenants(): Promise<AdminTenant[]> {
    const body = await this.json<unknown>("/v1/admin/tenants");
    if (!Array.isArray(body)) {
      throw new AdminError(
        "not_found",
        "Admin list tenants response was not an array.",
        { details: body },
      );
    }
    return body.map((item) => AdminTenantSchema.parse(item));
  }

  async getTenant(id: string): Promise<AdminTenantStatus> {
    const body = await this.json<unknown>(
      `/v1/admin/tenants/${encodeURIComponent(id)}`,
    );
    return AdminTenantStatusSchema.parse(body);
  }

  async deleteTenant(
    id: string,
    options?: { activeWork?: "refuse" | "drain" | "cancel" },
  ): Promise<void> {
    const activeWork = options?.activeWork ?? "refuse";
    await this.json<void>(
      `/v1/admin/tenants/${encodeURIComponent(id)}?activeWork=${activeWork}`,
      "DELETE",
    );
  }

  /**
   * The key of derived principal `principalId` on `tenantId`, from this client's admin key.
   * Valid once the Tenant was created with that principal in `principals`.
   */
  deriveTenantKey(tenantId: string, principalId: string): string {
    return deriveTenantKey(this.key, tenantId, principalId);
  }

  async createTenant(options: {
    name: string;
    principals?: readonly string[];
  }): Promise<{ tenant: TenantEnvelope; applicationKey: string }> {
    const principals = options.principals ?? [];
    for (const id of principals)
      if (!DERIVED_PRINCIPAL_ID_PATTERN.test(id) || id === "studio")
        throw new TypeError(
          `Principal id '${id}' must match ${DERIVED_PRINCIPAL_ID_PATTERN} and not be 'studio'.`,
        );
    if (new Set(principals).size !== principals.length)
      throw new TypeError("Principal ids must be unique.");
    if (principals.length) {
      await this.ensureCompatible();
      if (!this.features.includes("derived-principals"))
        throw new AdminError(
          "incompatible_host",
          "Host does not support derived principals (feature derived-principals); upgrade it with `nylorun up`.",
        );
    }
    const applicationKey = mintApplicationKey();
    const tenantId = newTenantId();
    const body = {
      tenantId,
      name: options.name,
      principalId: newPrincipalId(),
      credentialHash: hashCredential(applicationKey),
      idempotencyKey: randomUUID(),
      studioCredentialHash: hashCredential(deriveStudioToken(this.key, tenantId)),
      ...(principals.length
        ? {
            derivedPrincipals: principals.map((id) => ({
              id,
              credentialHash: hashCredential(
                deriveTenantKey(this.key, tenantId, id),
              ),
            })),
          }
        : {}),
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await this.request("/v1/admin/tenants", {
          method: "POST",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        if (error instanceof AdminError) throw error;
        lastError = error;
        if (attempt === 2) {
          throw new AdminError(
            "not_found",
            `Could not create Tenant after network errors: ${error instanceof Error ? error.message : String(error)}`,
            { details: error },
          );
        }
        continue;
      }
      if (response.status === 409) {
        const parsed = await readBody(response);
        throw new AdminError("tenant_conflict", "Tenant id conflict.", {
          status: 409,
          details: parsed,
        });
      }
      if (response.status >= 500) {
        lastError = await readBody(response);
        if (attempt === 2) {
          throwFromResponse(response.status, lastError);
        }
        continue;
      }
      const parsed = await readBody(response);
      if (response.status !== 201 && response.status !== 200) {
        throwFromResponse(response.status, parsed);
      }
      return {
        tenant: TenantEnvelopeSchema.parse(parsed),
        applicationKey,
      };
    }
    throw lastError instanceof AdminError
      ? lastError
      : new AdminError("not_found", "Could not create Tenant after retries.", {
          details: lastError,
        });
  }
}
