/**
 * Fixtures for the subject suites (Host feature `subject-headers`): a Tenant with one agent,
 * and a `call` that sends the application key as itself or acting for a subject with
 * `Nylorun-Subject` and `Nylorun-Scopes`.
 */
import { SCOPES_HEADER, SUBJECT_HEADER } from "@nylorun/core/compatibility";
import { SUBJECT_SCOPES, type SubjectScope } from "@nylorun/core/contracts";
import { manifestOf } from "../support/agents.js";
import { Agent } from "@nylorun/core/define";
import { startTestTenant, type StartTestTenantOptions } from "../support/tenant.js";

export const APP = "subject-suite-app-token-aaaaaaaa";
const KEK = Buffer.alloc(32, 7).toString("base64");

export interface As {
  readonly subject: string;
  readonly scopes: readonly SubjectScope[] | string;
}

export interface CallOptions {
  readonly as?: As;
  readonly key?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export interface Reply {
  readonly status: number;
  readonly body: any;
  readonly text: string;
}

/** Every scope a subject can hold. */
export const ALL_SCOPES: readonly SubjectScope[] = SUBJECT_SCOPES;

export function subjectHeaders(as: As): Record<string, string> {
  return {
    [SUBJECT_HEADER]: as.subject,
    [SCOPES_HEADER]: typeof as.scopes === "string" ? as.scopes : as.scopes.join(" "),
  };
}

export async function startSubjectTenant(
  options: {
    issuers?: StartTestTenantOptions["issuers"];
    /** The scripted model; default one that answers "ok". */
    modelProvider?: StartTestTenantOptions["modelProvider"];
  } = {}
) {
  const runtime = await startTestTenant({
    ...(options.issuers ? { issuers: options.issuers } : {}),
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: options.modelProvider ?? (async () => ({ output: [{ type: "text", text: "ok" }] })),
  });
  async function call(
    method: string,
    path: string,
    options: CallOptions = {}
  ): Promise<Reply> {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.key ?? APP}`,
        "content-type": "application/json",
        ...(options.as ? subjectHeaders(options.as) : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* SSE or empty */
    }
    return { status: response.status, body, text };
  }
  const agent = Agent({ id: "bot", name: "Bot" }).build();
  // The manifest `bot`, and its Agent `bot`, which no owner guard holds.
  const saved = await call("PUT", "/v1/agent-manifests/bot", { body: manifestOf(agent) });
  if (saved.status !== 200)
    throw new Error(`saving the agent manifest failed: ${saved.status} ${saved.text}`);
  const made = await call("PUT", "/v1/agents/bot", { body: { manifest: "bot" } });
  if (made.status !== 200) throw new Error(`making the Agent failed: ${made.status} ${made.text}`);
  return { runtime, call, close: () => runtime.close() };
}

export type SubjectTenant = Awaited<ReturnType<typeof startSubjectTenant>>;

/** A session owned by `as.subject`, created while acting for it. */
export async function createSession(
  tenant: SubjectTenant,
  id: string,
  as: As,
  extra: Record<string, unknown> = {}
): Promise<Reply> {
  return tenant.call("PUT", `/v1/sessions/${id}`, {
    as,
    body: {
      requestId: `put-${id}`,
      agent: "bot",
      ownerUserId: as.subject,
      ...extra,
    },
  });
}

/**
 * An Agent guarded for `as.subject` (`owner`), made from the manifest `bot` (of kind `none`) or
 * `bot-virtual` (kind `virtual`), with one bearer credential in its vault, created with the
 * application key alone: only `as.subject`'s sessions may run on it. Its id is `env-<subject>`,
 * unless `id` names another.
 */
export async function createEnvironment(
  tenant: SubjectTenant,
  as: As,
  options: { id?: string; url?: string; kind?: "virtual" | "none" } = {}
): Promise<{ environmentId: string; secretName: string }> {
  const environmentId = options.id ?? `env-${as.subject.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const path = `/v1/agents/${encodeURIComponent(environmentId)}`;
  let manifest = "bot";
  if (options.kind === "virtual") {
    manifest = "bot-virtual";
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    const saved = await tenant.call("PUT", `/v1/agent-manifests/${manifest}`, {
      body: manifestOf(agent, { name: manifest, runtime: { kind: "virtual" } }),
    });
    if (saved.status !== 200) throw new Error(`saving the agent manifest failed: ${saved.status} ${saved.text}`);
  }
  const environment = await tenant.call("PUT", path, {
    body: {
      requestId: `env-${environmentId}`,
      manifest,
      owner: as.subject,
    },
  });
  if (environment.status !== 200)
    throw new Error(
      `creating an Agent failed: ${environment.status} ${environment.text}`
    );
  const secret = await tenant.call(
    "PUT",
    `${path}/secrets/token`,
    {
      body: {
        requestId: `secret-${environmentId}`,
        type: "bearer",
        url: options.url ?? "https://mcp.example.com/tools",
        value: `secret-of-${as.subject}`,
      },
    }
  );
  if (secret.status !== 200)
    throw new Error(`creating a secret failed: ${secret.status} ${secret.text}`);
  return { environmentId, secretName: "token" };
}

/** Waits until the session reaches one of `statuses`, read with the application key. */
export async function settle(
  tenant: SubjectTenant,
  id: string,
  statuses: readonly string[] = ["completed"]
): Promise<Reply> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await tenant.call("GET", `/v1/sessions/${id}`);
    if (statuses.includes(view.body?.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${id} did not reach ${statuses.join(", ")}`);
}
