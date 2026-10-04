/**
 * Which client app a request comes from (Host feature `browser-access`), decided before the
 * bearer is looked at. `Nylorun-Key` names a publishable key of this Tenant; an `Origin` must
 * be on that key's allowlist, and only then does the response carry CORS headers. The
 * allowlist protects browsers from other sites' pages; it is not authentication, since a
 * non-browser can send any `Origin`: tokens authorize. A request whose bearer is a trusted
 * issuer's token (Host feature `trusted-issuers`) needs no publishable key.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PUBLISHABLE_KEY_HEADER } from "@nylorun/core/compatibility";
import { originAllowed } from "@nylorun/core/contracts";
import { browserOrigin, setCorsHeaders } from "../host/cors.js";
import type { TenantContext } from "./context.js";
import { claimedIssuer } from "./issuers.js";
import { fail, failOpaque } from "./http.js";

/** The client app of a request: its publishable key, and the origin when from a browser. */
export interface BrowserClient {
  readonly keyId: string;
  readonly origin?: string;
}

function single(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function identifyClient(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<BrowserClient | undefined> {
  const key = single(request, PUBLISHABLE_KEY_HEADER);
  const hasOrigin = request.headers.origin !== undefined;
  if (key === undefined) {
    // A trusted issuer's token needs no publishable key (Host feature `trusted-issuers`):
    // the token authorizes, and CORS comes from the operator's proxy.
    if (hasOrigin && !claimedIssuer(ctx, request.headers.authorization))
      fail(403, `Browser requests need ${PUBLISHABLE_KEY_HEADER}`, {
        code: "origin_rejected",
      });
    return undefined;
  }
  const row = await ctx.store.tx((t) => t.publishableKeyByKey(key));
  if (!row || row.revokedAt !== null) {
    ctx.config.logger.warn("credential rejected", {
      reason: "publishable_key_rejected",
    });
    return failOpaque();
  }
  if (!hasOrigin) return { keyId: row.id };
  const origin = browserOrigin(request);
  const origins = JSON.parse(row.originsJson) as string[];
  if (origin === undefined || !originAllowed(origins, origin)) {
    ctx.config.logger.warn("credential rejected", {
      reason: "origin_not_allowed",
      keyId: row.id,
    });
    return failOpaque();
  }
  setCorsHeaders(response, origin);
  return { keyId: row.id, origin };
}
