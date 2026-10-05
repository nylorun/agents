/**
 * Vaults and their credentials (`/v1/vaults/**`): secrets a session's tools use. Only an
 * application key acting for no one (an operator key, Studio) reaches these routes (protocol 7):
 * a request acting for a subject, or a trusted issuer's token, is `403 scope_required`. The
 * installation's own vaults (`scope: "installation"`) attach to any session; a vault of one
 * person (`ownerUserId`) attaches only to that person's sessions. A person's own credentials
 * come from the operator's credential resolver (`vault/sources.ts`), not from these routes.
 *
 * MCP OAuth connect (F9 C2): an application key starts one into an installation vault
 * (`/oauth/start`); the authorization server sends the browser back to the anonymous, unversioned
 * `GET /v1/oauth/callback`. Both only route: the gateway's keys module does the OAuth (F9-D14).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  CreateCredentialRequestSchema,
  CreateVaultRequestSchema,
  RotateCredentialRequestSchema,
  StartOAuthRequestSchema,
} from "@nylorun/core/contracts";
import {
  CreateCredentialRequest,
  CreateVaultRequest,
  CredentialInfo,
  DeletedResponse,
  ListCredentialsResponse,
  ListVaultsResponse,
  RotateCredentialRequest,
  StartOAuthRequest,
  StartOAuthResponse,
  VaultInfo,
} from "../../components.js";
import { HttpError } from "../../../tenant/http.js";
import { VaultError } from "../../../vault/error.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

/** The Management API's vault routes (`/v1/tenant/vaults`): a management key. */
const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };
/** The vault routes at `/v1/vaults`: an application key acting for no one, until protocol 8. */
const APPLICATION: RouteAccess = { credentials: ["application"], scopes: "never" };
/**
 * The OAuth callback: a browser sent back by the authorization server, with no credential and no
 * protocol header. The `state` it carries is the grant.
 */
const CALLBACK: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: "any",
  anonymous: true,
  unversioned: true,
};

/** Where the authorization server sends the browser back. */
export const OAUTH_CALLBACK_PATH = "/v1/oauth/callback";

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
const vaultId = z.object({ vaultId: z.string() });
const credentialId = vaultId.extend({ credentialId: z.string() });

/**
 * The vault routes under `base`: `/v1/tenant/vaults`, the Management API's, or `/v1/vaults`,
 * which application keys reach until protocol 8.
 */
function vaultRoutesAt(api: OpenAPIHono<TenantEnv>, base: string, access: RouteAccess): void {
  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}`,
      tags: ["Vaults"],
      summary: "Create a vault",
      description:
        "With `scope: \"installation\"` the installation's own vault, owned by `installation`, which any session may attach; or a vault of one person (`ownerUserId`), which only that person's sessions attach.",
      request: { body: body(CreateVaultRequest) },
      responses: {
        200: json(VaultInfo, "The vault"),
        409: { description: "The idempotency key was used for another vault" },
      },
    },
    async (c) => {
      const request = CreateVaultRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await c.env.tenant.vault.createVault(request));
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}`,
      tags: ["Vaults"],
      summary: "List vaults",
      description:
        "The installation vaults, after the vaults of `ownerUserId` when it names a person.",
      request: {
        query: z.object({
          ownerUserId: z
            .string()
            .optional()
            .meta({ description: "Also list this person's vaults" }),
        }),
      },
      responses: { 200: json(ListVaultsResponse, "The vaults") },
    },
    async (c) => {
      return jsonResponse(200, {
        vaults: await c.env.tenant.vault.listVaults(c.req.query("ownerUserId"), {
          installation: true,
        }),
      });
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}/{vaultId}`,
      tags: ["Vaults"],
      summary: "Get a vault",
      request: { params: vaultId },
      responses: { 200: json(VaultInfo, "The vault") },
    },
    async (c) => {
      return jsonResponse(200, await c.env.tenant.vault.getVault(c.req.param("vaultId")!));
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "delete",
      path: `${base}/{vaultId}`,
      tags: ["Vaults"],
      summary: "Delete a vault and its credentials",
      request: { params: vaultId },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      return jsonResponse(200, await c.env.tenant.vault.deleteVault(c.req.param("vaultId")!));
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}/{vaultId}/credentials`,
      tags: ["Vaults"],
      summary: "Add a credential",
      description:
        "A bearer token or OAuth tokens, bound to the URLs a tool may send them to.",
      request: { params: vaultId, body: body(CreateCredentialRequest) },
      responses: { 200: json(CredentialInfo, "The credential, without its secret") },
    },
    async (c) => {
      const request = CreateCredentialRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(
        200,
        await c.env.tenant.keys.createCredential(c.req.param("vaultId")!, request),
      );
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}/{vaultId}/credentials`,
      tags: ["Vaults"],
      summary: "List a vault's credentials",
      request: { params: vaultId },
      responses: { 200: json(ListCredentialsResponse, "The credentials, without their secrets") },
    },
    async (c) => {
      return jsonResponse(200, {
        credentials: await c.env.tenant.vault.listCredentials(c.req.param("vaultId")!),
      });
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}/{vaultId}/credentials/{credentialId}`,
      tags: ["Vaults"],
      summary: "Get a credential",
      request: { params: credentialId },
      responses: { 200: json(CredentialInfo, "The credential, without its secret") },
    },
    async (c) => {
      return jsonResponse(
        200,
        await c.env.tenant.vault.getCredential(c.req.param("vaultId")!, c.req.param("credentialId")!),
      );
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}/{vaultId}/credentials/{credentialId}`,
      tags: ["Vaults"],
      summary: "Rotate a credential's secret",
      request: { params: credentialId, body: body(RotateCredentialRequest) },
      responses: {
        200: json(CredentialInfo, "The credential"),
        409: { description: "A credential's type cannot change" },
      },
    },
    async (c) => {
      const request = RotateCredentialRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(
        200,
        await c.env.tenant.keys.rotateCredential(
          c.req.param("vaultId")!,
          c.req.param("credentialId")!,
          request,
        ),
      );
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "delete",
      path: `${base}/{vaultId}/credentials/{credentialId}`,
      tags: ["Vaults"],
      summary: "Delete a credential",
      request: { params: credentialId },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      return jsonResponse(
        200,
        await c.env.tenant.vault.deleteCredential(c.req.param("vaultId")!, c.req.param("credentialId")!),
      );
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}/{vaultId}/oauth/start`,
      tags: ["Vaults"],
      summary: "Start an MCP OAuth connect",
      description:
        "Signs the installation in to the remote MCP server at `url` (declared as `server`) and stores its OAuth credential, bound to `url`, in this installation vault. The Runtime discovers the server's authorization server (RFC 9728, RFC 8414), registers itself (RFC 7591) unless `clientId` names a registered client, and answers the URL to open in a browser; the sign-in returns to `GET /v1/oauth/callback` within `expiresAt`. The callback URL is `NYLORUN_PUBLIC_URL` + `/v1/oauth/callback`, or this request's own origin when the Host has no public URL. Application keys acting for no one only. `oauth_client_required` when the server offers no registration and no `clientId` was given.",
      request: { params: vaultId, body: body(StartOAuthRequest) },
      responses: {
        200: json(StartOAuthResponse, "Where to send the browser"),
        502: {
          description: "The authorization server, or its discovery, failed or refused (`oauth_failed`)",
        },
      },
    },
    async (c) => {
      const request = StartOAuthRequestSchema.parse(await readJson(c.req.raw));
      const tenant = c.env.tenant;
      const base = tenant.config.publicUrl ?? new URL(c.req.url).origin;
      return jsonResponse(
        200,
        await tenant.keys.startOAuth({
          vaultId: c.req.param("vaultId")!,
          server: request.server,
          url: request.url,
          ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
          redirectUri: `${base}${OAUTH_CALLBACK_PATH}`,
        }),
      );
    },
  );
}

export function vaultRoutes(api: OpenAPIHono<TenantEnv>): void {
  vaultRoutesAt(api, "/v1/tenant/vaults", MANAGEMENT);
  vaultRoutesAt(api, "/v1/vaults", APPLICATION);

  tenantRoute(
    api,
    CALLBACK,
    {
      method: "get",
      path: OAUTH_CALLBACK_PATH,
      tags: ["Vaults"],
      summary: "Finish an MCP OAuth connect",
      description:
        "Where the authorization server sends the browser back with `code` and `state` (or `error`). Exchanges the code once and stores the credential; answers a small HTML page. Needs no credential and no `Nylorun-Protocol`. A `state` is used once, for ten minutes (`oauth_state_invalid`).",
      request: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
      responses: {
        200: { description: "Connected", content: { "text/html": { schema: z.string() } } },
        502: { description: "The authorization server refused the code (`oauth_failed`)" },
      },
    },
    async (c) => {
      const state = c.req.query("state");
      const code = c.req.query("code");
      const error = c.req.query("error");
      if (!state) return page(400, "Sign-in failed", "The authorization server sent no state. Start the connect again.");
      try {
        await c.env.tenant.keys.finishOAuth({
          state,
          ...(code === undefined ? {} : { code }),
          ...(error === undefined ? {} : { error }),
        });
      } catch (failure) {
        if (failure instanceof HttpError || failure instanceof VaultError)
          return page(failure.status, "Sign-in failed", failure.message);
        c.env.tenant.config.logger.error("oauth_callback_failed", {
          error: failure instanceof Error ? failure.name : "unknown",
        });
        return page(500, "Sign-in failed", "The connect failed. Start it again.");
      }
      return page(200, "Connected", "Connected. You can close this tab.");
    },
  );
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** The callback's answer: a small page that loads nothing, is never cached and leaks no referrer. */
function page(status: number, title: string, message: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Nylorun</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}h1{font-size:1.25rem}</style>
</head><body><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}
