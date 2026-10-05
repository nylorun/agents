/**
 * Signing keys, for the application key only, and the public keys, for any caller that reached
 * the Tenant: the Runtime signs delivery tokens and capability links with them (protocol 7 has
 * no subject tokens, access policy, browser keys or revocations).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  RevokeSigningKeyRequestSchema,
  RotateSigningKeysRequestSchema,
  TOKEN_TTL_MAX_SECONDS,
} from "@nylorun/core/contracts";
import {
  Jwks,
  RevokeSigningKeyRequest,
  RotateSigningKeysRequest,
  SigningKeyList,
  SigningKeyView,
} from "../../components.js";
import { requireApplication } from "../../../tenant/auth.js";
import { publicJwk, signingKeyView } from "../../../tenant/signing-keys.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const APPLICATION: RouteAccess = { credentials: ["application"], scopes: "never" };

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});

export function accessRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    {
      credentials: ["application", "subject", "token"],
      scopes: "any",
      // Public keys: an Action endpoint verifies delivery tokens with them and holds no key.
      anonymous: true,
    },
    {
      method: "get",
      path: "/v1/access/jwks",
      tags: ["Access"],
      summary: "Get the public keys delivery tokens are signed with",
      description:
        "A JSON Web Key Set, to verify a delivery token without calling the Runtime. No " +
        "credential is needed.",
      responses: { 200: json(Jwks, "The public keys") },
    },
    async (c) => {
      // Anonymous: reads the public keys. Only when the current or standby key is missing does
      // it ask the keys service to create it, so a verifier never caches a set without them.
      const ctx = c.env.tenant;
      const read = () => ctx.store.tx((t) => t.signingKeys(["standby", "current", "previous"]));
      let rows = await read();
      if (!complete(rows)) {
        await ctx.keys.ensureSigningKeys();
        rows = await read();
      }
      return jsonResponse(200, { keys: rows.map(publicJwk) });
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "get",
      path: "/v1/access/signing-keys",
      tags: ["Access"],
      summary: "List signing keys",
      responses: { 200: json(SigningKeyList, "Standby, current, previous and revoked keys") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      const ctx = c.env.tenant;
      const read = () => ctx.store.tx((t) => t.signingKeys());
      let rows = await read();
      if (!complete(rows)) {
        await ctx.keys.ensureSigningKeys();
        rows = await read();
      }
      return jsonResponse(200, { keys: rows.map(signingKeyView) });
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "post",
      path: "/v1/access/signing-keys/rotate",
      tags: ["Access"],
      summary: "Rotate the signing keys",
      description:
        "The standby key signs from now on; the current one still verifies tokens it signed. `force` also ends every outstanding delivery token and capability link.",
      request: { body: body(RotateSigningKeysRequest) },
      responses: {
        200: json(SigningKeyList, "The keys after rotation"),
        409: { description: "The previous key may still verify outstanding tokens" },
      },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      const ctx = c.env.tenant;
      const request = RotateSigningKeysRequestSchema.parse(await readJson(c.req.raw));
      // The longest any token the Runtime signs lives (delivery tokens, capability links).
      const keys = await ctx.keys.rotateSigningKeys({
        maxTtlSeconds: TOKEN_TTL_MAX_SECONDS,
        force: request.force === true,
      });
      ctx.config.logger.info("signing keys rotated", { force: request.force === true });
      return jsonResponse(200, { keys });
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "post",
      path: "/v1/access/signing-keys/{kid}/revoke",
      tags: ["Access"],
      summary: "Revoke a signing key",
      request: { params: z.object({ kid: z.string() }), body: body(RevokeSigningKeyRequest) },
      responses: {
        200: json(SigningKeyView, "The key, revoked"),
        409: { description: "Rotate before revoking the current key" },
      },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      const ctx = c.env.tenant;
      RevokeSigningKeyRequestSchema.parse(await readJson(c.req.raw));
      const row = await ctx.store.tx((t) => ctx.signingKeys.revoke(t, c.req.param("kid")!));
      ctx.config.logger.info("signing key revoked", { kid: row.id });
      return jsonResponse(200, signingKeyView(row));
    },
  );
}

/** True when the Tenant has a current and a standby signing key. */
function complete(rows: readonly { state: string }[]): boolean {
  return rows.some((row) => row.state === "current") && rows.some((row) => row.state === "standby");
}
