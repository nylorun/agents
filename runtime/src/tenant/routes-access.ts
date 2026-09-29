/**
 * Access management (Host feature `subject-tokens`), for the application key only:
 *
 * - `POST /v1/tokens`: mint a subject token;
 * - `GET`/`PUT /v1/access/policy`: the access policy;
 * - `GET /v1/access/signing-keys`, `POST …/rotate`, `POST …/:kid/revoke`: signing keys;
 * - `GET /v1/access/jwks`: the public keys;
 * - `POST /v1/access/revocations`: end a subject's tokens and open streams.
 *
 * `routeAccess` refuses every one of these to subjects and tokens before this runs; the
 * `requireApplication` here is a second check. Subjects travel in bodies, not paths, because
 * they may be email addresses and request paths are logged.
 */
import type { IncomingMessage } from "node:http";
import {
  CreateTokenRequestSchema,
  PutAccessPolicyRequestSchema,
  RevokeSigningKeyRequestSchema,
  RevokeSubjectRequestSchema,
  RotateSigningKeysRequestSchema,
} from "@nylorun/core/contracts";
import { signalSubjectRevoked } from "../streams/relay.js";
import { readPolicy, writePolicy } from "./access-policy.js";
import { requireApplication } from "./auth.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail, readBody } from "./http.js";
import { endSubjectStreams } from "./live.js";
import { publicJwk, signingKeyView } from "./signing-keys.js";
import { mintToken } from "./tokens.js";

export async function dispatchAccess(
  ctx: TenantContext,
  scope: AuthScope,
  method: string | undefined,
  path: readonly string[],
  request: IncomingMessage
): Promise<unknown> {
  requireApplication(scope);
  const keys = ctx.signingKeys;
  if (path[1] === "tokens" && path.length === 2 && method === "POST")
    return mintToken(ctx, CreateTokenRequestSchema.parse(await readBody(request)));
  if (path[1] !== "access") return fail(404, "Route not found");
  const [, , resource, id, action] = path;
  const n = path.length;
  if (resource === "policy" && n === 3) {
    if (method === "GET")
      return { policy: await ctx.store.tx((t) => readPolicy(t)) };
    if (method === "PUT") {
      const body = PutAccessPolicyRequestSchema.parse(await readBody(request));
      await ctx.store.tx((t) => writePolicy(t, body.policy));
      return { policy: body.policy };
    }
  }
  if (resource === "signing-keys") {
    if (n === 3 && method === "GET") {
      const kek = keys.kek();
      const rows = await ctx.store.tx(async (t) => {
        await keys.ensure(t, kek);
        return t.signingKeys();
      });
      return { keys: rows.map(signingKeyView) };
    }
    if (n === 4 && id === "rotate" && method === "POST") {
      const body = RotateSigningKeysRequestSchema.parse(await readBody(request));
      const kek = keys.kek();
      const rows = await ctx.store.tx(async (t) =>
        keys.rotate(
          t,
          kek,
          (await readPolicy(t)).tokens.maxTtlSeconds,
          body.force === true
        )
      );
      ctx.config.logger.info("signing keys rotated", {
        force: body.force === true,
      });
      return { keys: rows.map(signingKeyView) };
    }
    if (n === 5 && action === "revoke" && method === "POST") {
      RevokeSigningKeyRequestSchema.parse(await readBody(request));
      const row = await ctx.store.tx((t) => keys.revoke(t, id!));
      ctx.config.logger.info("signing key revoked", { kid: row.id });
      return signingKeyView(row);
    }
  }
  if (resource === "jwks" && n === 3 && method === "GET") {
    const kek = keys.kek();
    const rows = await ctx.store.tx(async (t) => {
      await keys.ensure(t, kek);
      return t.signingKeys(["standby", "current", "previous"]);
    });
    return { keys: rows.map(publicJwk) };
  }
  if (resource === "revocations" && n === 3 && method === "POST") {
    const body = RevokeSubjectRequestSchema.parse(await readBody(request));
    return revokeSubject(ctx, body.subject);
  }
  return fail(404, "Route not found");
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
      endSubjectStreams(ctx.live, subject, next);
      const streams = ctx.live.wiring?.streams;
      if (streams)
        await signalSubjectRevoked(streams, ctx.config.tenantId, subject, next).catch(
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

