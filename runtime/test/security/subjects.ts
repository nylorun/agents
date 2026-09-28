/**
 * Fixtures for the subject suites (Host feature `subject-headers`): a Tenant with one agent
 * and one executor, and a `call` that sends the application key as itself or acting for a
 * subject with `Nylorun-Subject` and `Nylorun-Scopes`.
 */
import { SCOPES_HEADER, SUBJECT_HEADER } from "@nylorun/core/compatibility";
import { SUBJECT_SCOPES, type SubjectScope } from "@nylorun/core/contracts";
import { Agent } from "@nylorun/core/define";
import { startTestTenant } from "../support/tenant.js";

export const APP = "subject-suite-app-token-aaaaaaaa";
export const EXECUTOR = "subject-suite-executor-token-bbbb";
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

export async function startSubjectTenant() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    executors: [
      { token: EXECUTOR, agentId: "bot", implementationVersion: "dev" },
    ],
    modelProvider: async () => ({ output: [{ type: "text", text: "ok" }] }),
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
  const saved = await call("PUT", "/v1/agents/bot", {
    body: {
      requestId: "save-bot",
      manifest: agent.manifest,
      implementationVersion: "dev",
    },
  });
  if (saved.status !== 200)
    throw new Error(`saving the agent failed: ${saved.status} ${saved.text}`);
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
      agentId: "bot",
      ownerUserId: as.subject,
      ...extra,
    },
  });
}

/** A vault owned by `as.subject`, with one bearer credential. */
export async function createVault(
  tenant: SubjectTenant,
  as: As
): Promise<{ vaultId: string; credentialId: string }> {
  const vault = await tenant.call("POST", "/v1/vaults", {
    as,
    body: {
      requestId: `vault-${as.subject}`,
      idempotencyKey: `vault-${as.subject}`,
      name: `${as.subject}'s vault`,
      ownerUserId: as.subject,
    },
  });
  if (vault.status !== 200)
    throw new Error(`creating a vault failed: ${vault.status} ${vault.text}`);
  const credential = await tenant.call(
    "POST",
    `/v1/vaults/${vault.body.id}/credentials`,
    {
      as,
      body: {
        requestId: `cred-${as.subject}`,
        idempotencyKey: `cred-${as.subject}`,
        name: "token",
        auth: {
          type: "bearer",
          url: "https://mcp.example.com/tools",
          token: `secret-of-${as.subject}`,
        },
      },
    }
  );
  if (credential.status !== 200)
    throw new Error(
      `creating a credential failed: ${credential.status} ${credential.text}`
    );
  return { vaultId: vault.body.id, credentialId: credential.body.id };
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
