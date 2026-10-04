import type { AuthScope, TenantContext } from "../tenant/context.js";
import { accessOf } from "../tenant/auth.js";
import { fail } from "../tenant/http.js";
import type { ReadAccess } from "./types.js";
export function readAccess(scope: AuthScope): ReadAccess {
  const access = accessOf(scope);
  return {
    ...(access ? { owner: access.owner } : {}),
    ...(access?.agents ? { agents: [...access.agents] } : {}),
  };
}
export function readStoreOf(ctx: TenantContext) {
  return ctx.reads ?? fail(503, "Session reads are unavailable", { code: "reads_unavailable" });
}
