/**
 * Where a session's MCP or HTTP tool credential comes from: the vaults attached to the session,
 * and nothing else. OSS holds no OAuth client and asks no credential resolver (protocol 10,
 * D49): a person's own keys live in their user vault, the installation's in its vaults.
 *
 * Both authorize sites call this: the gateway (`gates/tenant-vaults.ts`, remote MCP servers and
 * HTTP tools in the gates service) and the Tenant (`tenant/effects.ts`, the in-process MCP pool
 * and Tool Gate). The session comes from its row, never from the harness.
 */
import type { CredentialSelection } from "@nylorun/core/contracts";
import type { AuthorizeResult, VaultService } from "./service.js";

/** The session a request is made for: its row, as stored. */
export interface CredentialSession {
  readonly id: string;
  readonly ownerUserId: string;
  readonly vaultIds?: readonly string[];
  readonly credentialSelections?: readonly CredentialSelection[];
}

/** One MCP or HTTP tool request: its URL, and the name a credential selection matches. */
export interface McpCredentialRequest {
  readonly url: string;
  /** The server's name, or the HTTP tool's `credential`: what a credential selection names. */
  readonly serverName?: string;
}

/**
 * The credential of one request made for `session`: the vault's answer over the session's
 * attached vaults (`VaultService.authorize`).
 */
export function sessionCredentials(
  vault: Pick<VaultService, "authorize">,
  session: CredentialSession,
  request: McpCredentialRequest,
): Promise<AuthorizeResult> {
  return vault.authorize({
    sessionId: session.id,
    vaultIds: session.vaultIds ?? [],
    credentialSelections: session.credentialSelections ?? [],
    url: request.url,
    ...(request.serverName === undefined ? {} : { serverName: request.serverName }),
  });
}
