/**
 * Access management (Host feature `subject-tokens`), for the application key only: subject
 * tokens, the access policy, signing keys, publishable keys and subject revocation; and the
 * public keys, for any caller that reached the Tenant.
 *
 * Subjects travel in bodies, not paths, because they may be email addresses and request paths
 * are logged.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { newPublishableKey, newPublishableKeyId } from "@nylorun/core/compatibility";
import {
  CreatePublishableKeyRequestSchema,
  CreateTokenRequestSchema,
  PutAccessPolicyRequestSchema,
  RevokeSigningKeyRequestSchema,
  RevokeSubjectRequestSchema,
  RotateSigningKeysRequestSchema,
  UpdatePublishableKeyRequestSchema,
} from "@nylorun/core/contracts";
import {
  AccessPolicyResponse,
  CreatePublishableKeyRequest,
  CreateTokenRequest,
  CreateTokenResponse,
  Jwks,
  ListPublishableKeysResponse,
  PublishableKey,
  PutAccessPolicyRequest,
  RevokeSigningKeyRequest,
  RevokeSubjectRequest,
  RevokeSubjectResponse,
  RotateSigningKeysRequest,
  SigningKeyList,
  SigningKeyView,
  UpdatePublishableKeyRequest,
} from "../../components.js";
import type { PublishableKey as PublishableKeyBody } from "@nylorun/core/contracts";
import type { PublishableKeyRow } from "../../../store/types.js";
import { signalSubjectRevoked } from "../../../streams/control.js";
import { readPolicy, writePolicy } from "../../../tenant/access-policy.js";
import { currentBasin, endSubjectStreams } from "../../../tenant/session-streams.js";
import type { TenantContext } from "../../../tenant/context.js";
import { requireApplication } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import { publicJwk, signingKeyView } from "../../../tenant/signing-keys.js";
import { mintToken } from "../../../tenant/tokens.js";
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
const keyId = z.object({ keyId: z.string() });

export function accessRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    {
      credentials: ["application", "subject", "token", "publishable"],
      scopes: "any",
      browser: true,
      // Public keys: an Action endpoint verifies delivery tokens with them and holds no key.
      anonymous: true,
    },
    {
      method: "get",
      path: "/v1/access/jwks",
      tags: ["Access"],
      summary: "Get the public keys subject and delivery tokens are signed with",
      description:
        "A JSON Web Key Set, to verify a subject token or a delivery token without calling the " +
        "Runtime. No credential is needed.",
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
      method: "post",
      path: "/v1/tokens",
      tags: ["Access"],
      summary: "Mint a subject token",
      description:
        "A token for one person and one role of the access policy, for their browser or app to call the Runtime with. At most 15 minutes.",
      request: { body: body(CreateTokenRequest) },
      responses: { 200: json(CreateTokenResponse, "The token, its scopes and expiry") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      return jsonResponse(
        200,
        await mintToken(c.env.tenant, CreateTokenRequestSchema.parse(await readJson(c.req.raw))),
      );
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "get",
      path: "/v1/access/policy",
      tags: ["Access"],
      summary: "Get the access policy",
      responses: { 200: json(AccessPolicyResponse, "Roles, the anonymous grant and token lifetime") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      return jsonResponse(200, { policy: await c.env.tenant.store.tx((t) => readPolicy(t)) });
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "put",
      path: "/v1/access/policy",
      tags: ["Access"],
      summary: "Set the access policy",
      request: { body: body(PutAccessPolicyRequest) },
      responses: { 200: json(AccessPolicyResponse, "The policy now in force") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      const request = PutAccessPolicyRequestSchema.parse(await readJson(c.req.raw));
      await c.env.tenant.store.tx((t) => writePolicy(t, request.policy));
      return jsonResponse(200, { policy: request.policy });
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
        "The standby key signs from now on; the current one still verifies tokens it signed. `force` also ends every outstanding token.",
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
      const maxTtlSeconds = await ctx.store.tx(async (t) => (await readPolicy(t)).tokens.maxTtlSeconds);
      const keys = await ctx.keys.rotateSigningKeys({ maxTtlSeconds, force: request.force === true });
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

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "get",
      path: "/v1/access/publishable-keys",
      tags: ["Access"],
      summary: "List publishable keys",
      responses: { 200: json(ListPublishableKeysResponse, "The keys, revoked ones included") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      return jsonResponse(200, {
        keys: (await c.env.tenant.store.tx((t) => t.publishableKeys())).map(publishableKeyView),
      });
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "post",
      path: "/v1/access/publishable-keys",
      tags: ["Access"],
      summary: "Create a publishable key",
      description:
        "A key a browser page on one of the origins sends as `Nylorun-Key`. Public by design; it grants the policy's anonymous scopes.",
      request: { body: body(CreatePublishableKeyRequest) },
      responses: {
        200: json(PublishableKey, "The key"),
        409: { description: "A key with this name exists" },
      },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      const ctx = c.env.tenant;
      const request = CreatePublishableKeyRequestSchema.parse(await readJson(c.req.raw));
      const row = {
        id: newPublishableKeyId(),
        key: newPublishableKey(ctx.config.tenantId),
        name: request.name,
        originsJson: JSON.stringify(request.origins),
        createdAt: new Date().toISOString(),
        revokedAt: null,
      };
      await ctx.store.tx(async (t) => {
        if ((await t.publishableKeys()).some((other) => other.name === request.name))
          fail(409, `A publishable key named ${request.name} exists`);
        await t.insertPublishableKey(row);
      });
      ctx.config.logger.info("publishable key created", { keyId: row.id });
      return jsonResponse(200, publishableKeyView(row));
    },
  );

  for (const method of ["put", "delete"] as const)
    tenantRoute(
      api,
      APPLICATION,
      {
        method,
        path: "/v1/access/publishable-keys/{keyId}",
        tags: ["Access"],
        summary: method === "put" ? "Set a publishable key's origins" : "Revoke a publishable key",
        request: {
          params: keyId,
          ...(method === "put" ? { body: body(UpdatePublishableKeyRequest) } : {}),
        },
        responses: {
          200: json(PublishableKey, method === "put" ? "The key" : "The key, revoked (again: unchanged)"),
        },
      },
      async (c) => {
        requireApplication(c.get("scope"));
        const ctx = c.env.tenant;
        const id = c.req.param("keyId")!;
        const patch =
          method === "put"
            ? {
                originsJson: JSON.stringify(
                  UpdatePublishableKeyRequestSchema.parse(await readJson(c.req.raw)).origins,
                ),
              }
            : { revokedAt: new Date().toISOString() };
        const row = await ctx.store.tx(async (t) => {
          const existing = (await t.publishableKey(id)) ?? fail(404, "Publishable key not found");
          // Revoking twice keeps the first time.
          if (method === "delete" && existing.revokedAt !== null) return existing;
          await t.updatePublishableKey(id, patch);
          return { ...existing, ...patch };
        });
        ctx.config.logger.info(
          method === "put" ? "publishable key updated" : "publishable key revoked",
          { keyId: row.id },
        );
        return jsonResponse(200, publishableKeyView(row));
      },
    );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "post",
      path: "/v1/access/revocations",
      tags: ["Access"],
      summary: "Revoke a subject",
      description:
        "Ends every token minted for the subject so far, and their open streams on every process. Turns in progress continue.",
      request: { body: body(RevokeSubjectRequest) },
      responses: { 200: json(RevokeSubjectResponse, "The subject's new epoch") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      const request = RevokeSubjectRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await revokeSubject(c.env.tenant, request.subject));
    },
  );
}

/** A publishable key as the API shows it. */
export function publishableKeyView(row: PublishableKeyRow): PublishableKeyBody {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    origins: JSON.parse(row.originsJson) as string[],
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Ends every token of `subject` minted so far: bumps its epoch, then ends its open streams
 * here and, through `tenant/control`, on every other process. Running turns continue.
 */
export async function revokeSubject(
  ctx: TenantContext,
  subject: string
): Promise<{ subject: string; epoch: number }> {
  const epoch = await ctx.store.tx(async (t) => {
    const next = await t.bumpSubjectEpoch(subject, new Date().toISOString());
    t.afterCommit(async () => {
      endSubjectStreams(ctx.sessionStreams, subject, next);
      const streams = ctx.sessionStreams.wiring?.streams;
      if (streams)
        await signalSubjectRevoked(streams, currentBasin(ctx), subject, next).catch(
          (error: unknown) =>
            ctx.config.logger.warn("subject revocation signal failed", {
              message: error instanceof Error ? error.message : String(error),
            })
        );
    });
    return next;
  });
  ctx.config.logger.info("subject revoked", { epoch });
  return { subject, epoch };
}


/** True when the Tenant has a current and a standby signing key. */
function complete(rows: readonly { state: string }[]): boolean {
  return rows.some((row) => row.state === "current") && rows.some((row) => row.state === "standby");
}
