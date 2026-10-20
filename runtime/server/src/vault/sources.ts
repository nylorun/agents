/**
 * Where a session's MCP or HTTP tool credential comes from: the vault of the Environment the
 * session names (D56), and nothing else. OSS holds no OAuth client and asks no credential
 * resolver (protocol 10, D49): a person's own keys live in the Environment the app maps to them.
 *
 * Both authorize sites call this: the gateway (`gates/tenant-vaults.ts`, remote MCP servers and
 * HTTP tools in the gates service) and the Tenant (`tenant/effects.ts`, the in-process MCP pool
 * and Tool Gate). The session comes from its row, never from the harness.
 */
import { isSubject } from "@nylorun/core/contracts";
import type { AuthorizeResult, VaultService } from "./service.js";
import { workloadOriginRefused, workloadToken, WorkloadTokenUnavailable } from "./workload-token.js";

/** The session a request is made for: its row, as stored. */
export interface CredentialSession {
  readonly id: string;
  readonly ownerUserId: string;
  readonly environmentId?: string;
}

/** One MCP or HTTP tool request: its URL, and the server's (or HTTP tool credential's) name. */
export interface McpCredentialRequest {
  readonly url: string;
  /** The server's name, or the HTTP tool's `credential`, for audit and messages. */
  readonly serverName?: string;
}

/**
 * The credential of one request made for `session`: the answer of its Environment's vault
 * (`VaultService.authorize`). A credential with an identity header (R2b C2)
 * gets the session owner's subject in it (Q2), from the session row: the run token names no
 * owner, so neither the model nor the manifest can change it. A session whose owner is no
 * person (the reserved `installation`) sends none (Q3).
 */
export async function sessionCredentials(
  vault: Pick<VaultService, "authorize">,
  session: CredentialSession,
  request: McpCredentialRequest,
): Promise<AuthorizeResult> {
  const authorized = await vault.authorize({
    sessionId: session.id,
    ...(session.environmentId === undefined ? {} : { environmentId: session.environmentId }),
    url: request.url,
  });
  const result =
    authorized.status === "authorized" && authorized.workload ? await withWorkloadToken(authorized) : authorized;
  if (result.status !== "authorized" || !result.identity || !isSubject(session.ownerUserId))
    return result;
  return {
    ...result,
    headers: { ...result.headers, [result.identity.header]: session.ownerUserId },
  };
}

/**
 * A `workload` credential's request with the Runtime's workload token as its bearer, read now
 * (#496), or refused: when `via`'s origin is not one the operator lists, or the token cannot be
 * read. Never sent without it.
 */
async function withWorkloadToken(result: Extract<AuthorizeResult, { status: "authorized" }>): Promise<AuthorizeResult> {
  const refused = (reason: string): AuthorizeResult => ({ status: "refused", url: result.url, credentialIds: [], reason });
  const origin = result.via === undefined ? "a workload credential needs via" : workloadOriginRefused(result.via);
  if (origin !== undefined) return refused(origin);
  try {
    return { ...result, headers: { ...result.headers, authorization: `Bearer ${await workloadToken()}` } };
  } catch (error) {
    if (error instanceof WorkloadTokenUnavailable) return refused(error.message);
    throw error;
  }
}
