/**
 * The network half of an MCP OAuth connect (F9 C2): discovery, dynamic client registration,
 * the authorization URL and the code exchange, with the MCP SDK's auth helpers over the fetch
 * it is given (the Host's `guardedFetch` in the gateway). `VaultService.startOAuth` and
 * `finishOAuth` call these outside any transaction and hold the secrets; nothing here stores
 * or logs one.
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { HttpError } from "../tenant/http.js";
import { OutboundFailed, OutboundRefused } from "../tenant/outbound.js";

export type TokenEndpointAuth = "none" | "client_secret_basic" | "client_secret_post";

/** Where and how to sign in to an MCP server. */
export interface OAuthServer {
  readonly authorizationServerUrl: string;
  readonly metadata: AuthorizationServerMetadata;
  /** The protected resource's own `resource` (RFC 9728), sent as the RFC 8707 indicator. */
  readonly resource?: string;
  /** The scopes the protected resource names, space separated. */
  readonly scope?: string;
}

/** The client this installation signs in as. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuth: TokenEndpointAuth;
}

/** A failed step, as the Tenant API answers it: a refused address is the Host's rule (400). */
export function oauthFailure(step: string, error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof OutboundRefused)
    return new HttpError(400, `${error.message} (OAuth ${step})`, { code: "request_rejected" });
  if (error instanceof OAuthError)
    return new HttpError(502, `The authorization server refused the ${step} (${error.errorCode})`, {
      code: "oauth_failed",
    });
  if (error instanceof OutboundFailed)
    return new HttpError(502, `The OAuth ${step} failed: ${error.message}`, { code: "oauth_failed" });
  return new HttpError(502, `The OAuth ${step} failed: the authorization server's answer was not usable`, {
    code: "oauth_failed",
  });
}

function httpUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(502, `The authorization server's ${what} is not a URL`, { code: "oauth_failed" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new HttpError(502, `The authorization server's ${what} is not an http(s) URL`, {
      code: "oauth_failed",
    });
  return url;
}

/**
 * RFC 9728 protected resource metadata, then RFC 8414 (or OpenID) metadata of its first
 * authorization server. A server without the former is its own authorization server (the MCP
 * spec's fallback); a refused address is never a fallback.
 */
export async function discoverOAuthServer(url: string, fetchFn: typeof fetch): Promise<OAuthServer> {
  let authorizationServerUrl: string | undefined;
  let resource: string | undefined;
  let scope: string | undefined;
  try {
    const protectedResource = await discoverOAuthProtectedResourceMetadata(url, {}, fetchFn);
    authorizationServerUrl = protectedResource.authorization_servers?.[0];
    if (protectedResource.resource) {
      if (!checkResourceAllowed({ requestedResource: url, configuredResource: protectedResource.resource }))
        throw new HttpError(
          502,
          `The MCP server's protected resource metadata names another resource (${protectedResource.resource})`,
          { code: "oauth_failed" },
        );
      resource = protectedResource.resource;
    }
    if (protectedResource.scopes_supported?.length) scope = protectedResource.scopes_supported.join(" ");
  } catch (error) {
    if (error instanceof OutboundRefused || error instanceof HttpError) throw oauthFailure("discovery", error);
    // No RFC 9728 metadata: the MCP server is its own authorization server.
  }
  authorizationServerUrl ??= new URL("/", url).href;
  httpUrl(authorizationServerUrl, "address");
  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn });
  } catch (error) {
    throw oauthFailure("discovery", error);
  }
  if (!metadata)
    throw new HttpError(
      502,
      `No OAuth authorization server metadata at ${new URL(authorizationServerUrl).origin}: the MCP server does not support OAuth sign-in`,
      { code: "oauth_failed" },
    );
  httpUrl(metadata.authorization_endpoint, "authorization endpoint");
  httpUrl(metadata.token_endpoint, "token endpoint");
  return {
    authorizationServerUrl,
    metadata,
    ...(resource === undefined ? {} : { resource }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function authMethodOf(value: unknown, secret: string | undefined): TokenEndpointAuth {
  if (value === undefined) return secret ? "client_secret_basic" : "none";
  if (value === "none" || value === "client_secret_basic" || value === "client_secret_post") {
    if (value !== "none" && !secret)
      throw new HttpError(502, "The authorization server registered a confidential client without a secret", {
        code: "oauth_failed",
      });
    return value;
  }
  throw new HttpError(502, `The authorization server's client authentication ${String(value)} is not supported`, {
    code: "oauth_failed",
  });
}

/**
 * The client to sign in as: the operator's `clientId` (a public client) when given, else one
 * registered now (RFC 7591) when the server offers registration, else `oauth_client_required`.
 */
export async function oauthClient(
  server: OAuthServer,
  options: { clientId?: string; redirectUri: string; fetchFn: typeof fetch },
): Promise<OAuthClient> {
  if (options.clientId) return { clientId: options.clientId, tokenEndpointAuth: "none" };
  if (!server.metadata.registration_endpoint)
    throw new HttpError(
      400,
      "The authorization server offers no dynamic client registration: register a client with it and pass its id (--client-id)",
      { code: "oauth_client_required" },
    );
  httpUrl(server.metadata.registration_endpoint, "registration endpoint");
  try {
    const registered = await registerClient(server.authorizationServerUrl, {
      metadata: server.metadata,
      clientMetadata: {
        client_name: "Nylorun",
        redirect_uris: [options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      ...(server.scope === undefined ? {} : { scope: server.scope }),
      fetchFn: options.fetchFn,
    });
    return {
      clientId: registered.client_id,
      ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
      tokenEndpointAuth: authMethodOf(registered.token_endpoint_auth_method, registered.client_secret),
    };
  } catch (error) {
    throw oauthFailure("client registration", error);
  }
}

/** The authorization URL, with a fresh S256 PKCE verifier. */
export async function authorizationUrl(
  server: OAuthServer,
  client: OAuthClient,
  options: { redirectUri: string; state: string },
): Promise<{ authorizeUrl: string; codeVerifier: string }> {
  try {
    const started = await startAuthorization(server.authorizationServerUrl, {
      metadata: server.metadata,
      clientInformation: { client_id: client.clientId },
      redirectUrl: options.redirectUri,
      state: options.state,
      ...(server.scope === undefined ? {} : { scope: server.scope }),
      ...(server.resource === undefined ? {} : { resource: server.resource }),
    });
    return { authorizeUrl: started.authorizationUrl.href, codeVerifier: started.codeVerifier };
  } catch (error) {
    throw oauthFailure("authorization request", error);
  }
}

/** Adds the client's authentication to a token request, as `tokenEndpointAuth` says. */
export function addClientAuthentication(
  client: OAuthClient,
  headers: Headers,
  params: URLSearchParams,
): void {
  if (client.tokenEndpointAuth === "client_secret_basic") {
    const encoded = Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? "")}`,
    ).toString("base64");
    headers.set("authorization", `Basic ${encoded}`);
    return;
  }
  params.set("client_id", client.clientId);
  if (client.tokenEndpointAuth === "client_secret_post") params.set("client_secret", client.clientSecret ?? "");
}

/** Exchanges the authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCode(options: {
  tokenEndpoint: string;
  client: OAuthClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
  fetchFn: typeof fetch;
}): Promise<OAuthTokens> {
  const { client } = options;
  const clientInformation: OAuthClientInformationMixed = {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  };
  try {
    return await exchangeAuthorization(options.tokenEndpoint, {
      // Only the token endpoint is read from it.
      metadata: { token_endpoint: options.tokenEndpoint } as AuthorizationServerMetadata,
      clientInformation,
      authorizationCode: options.code,
      codeVerifier: options.codeVerifier,
      redirectUri: options.redirectUri,
      ...(options.resource === undefined ? {} : { resource: options.resource }),
      addClientAuthentication: (headers, params) => addClientAuthentication(client, headers, params),
      fetchFn: options.fetchFn,
    });
  } catch (error) {
    throw oauthFailure("code exchange", error);
  }
}
