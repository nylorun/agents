/**
 * `GET /v1/me` (Host feature `trusted-issuers`): who the Runtime takes the caller to be, for any
 * credential that acts on the Tenant. It shows what a trusted issuer's token renders to (its
 * subject, scopes, agents and sandbox grants), so an operator can check an identity file, and
 * Studio can check a forwarded token for the `studio` scope.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  CALLER_SCOPES,
  SUBJECT_SCOPES,
  type CallerScope,
  type MeResponse as MeBody,
} from "@nylorun/core/contracts";
import { MeResponse } from "../../components.js";
import type { AuthScope } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute } from "../define.js";
import { jsonResponse } from "../respond.js";

function ordered(scopes: Iterable<CallerScope>): CallerScope[] {
  const held = new Set(scopes);
  return CALLER_SCOPES.filter((scope) => held.has(scope));
}

/** The caller as `GET /v1/me` reports it. */
export function describeCaller(scope: AuthScope): MeBody {
  switch (scope.kind) {
    case "application":
      return { scopes: [...SUBJECT_SCOPES], agents: "*", via: `application:${scope.principalId}` };
    case "subject":
      return { subject: scope.subject, scopes: ordered(scope.scopes), agents: "*", via: "subject" };
    case "token":
      return {
        subject: scope.subject,
        scopes: ordered(scope.scopes),
        agents: scope.agents === "*" ? "*" : [...scope.agents].sort(),
        sandboxes: [...(scope.sandboxes ?? [])],
        via: scope.issuer === undefined ? "token" : `issuer:${scope.issuer}`,
      };
    default:
      return fail(403, "This credential acts on no Tenant resource");
  }
}

export function meRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    { credentials: ["application", "subject", "token"], scopes: "any", browser: true },
    {
      method: "get",
      path: "/v1/me",
      tags: ["Access"],
      summary: "Get who the caller is",
      description:
        "The subject, scopes, agents and sandbox grants of the credential that sends it: an " +
        "application key (alone or acting for a subject), a subject token, or a trusted " +
        "issuer's token (`via: issuer:<name>`).",
      responses: {
        200: {
          description: "The caller",
          content: { "application/json": { schema: MeResponse } },
        },
      },
    },
    (c) => jsonResponse(200, describeCaller(c.get("scope"))),
  );
}
