/**
 * Same-origin client for the Studio server. A browser tab holds only the
 * HttpOnly session cookie; an embedded Studio holds a bearer session in
 * memory (`embed/session.ts`). The server adds every Runtime credential.
 */
import { createClient } from "@nylorun/agents/client";
import { createManagementClient } from "@nylorun/admin/client";
import { embedSession } from "./embed/index.ts";

export type StudioFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** The installation's one Tenant, as the Studio server reports it. */
export type StudioTenant = Readonly<{
  /** Null until the server has read it from the Runtime. */
  id: string | null;
  name: string | null;
  state: "open" | "unavailable";
  /** Why it is unavailable and how to repair it. */
  message?: string;
}>;

export type StudioHello = Readonly<{
  version: string;
  runtime: Readonly<{ compatible: boolean; message?: string }>;
  tenant: StudioTenant;
}>;

/** The Studio server has no session for this browser. */
export class StudioSignedOutError extends Error {
  constructor(message = "Studio session required.") {
    super(message);
    this.name = "StudioSignedOutError";
  }
}

/** Server path that proxies one Tenant's Tenant API. */
export function tenantRuntimePath(tenantId: string): string {
  return `/_studio/tenants/${encodeURIComponent(tenantId)}/runtime`;
}

/** Tenant scope from a dashboard path: `/tenants/<id>/…` → router basename. */
export function tenantScope(
  pathname: string,
): Readonly<{ tenantId: string; basename: string }> | undefined {
  const match = /^\/tenants\/([^/]+)/u.exec(pathname);
  if (!match) return undefined;
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  return tenantId ? { tenantId, basename: `/tenants/${match[1]}` } : undefined;
}

/** Dashboard URL of a Tenant. */
export function tenantHref(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}`;
}

/** The cookie's plain `fetch`, or an embedded session's bearer `fetch`. */
function sessionFetch(): StudioFetch {
  return embedSession()?.fetch ?? fetch;
}

/** Same-origin fetch with the session. Accepts only absolute paths. */
export function studioFetch(
  path: string,
  init?: RequestInit,
  fetcher: StudioFetch = sessionFetch(),
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("studioFetch only accepts same-origin paths.");
  return fetcher(path, { ...init, credentials: "same-origin" });
}

/** `fetch` for one Tenant's Tenant API routes, e.g. `/v1/tenant/model`. */
export function tenantRuntime(tenantId: string, fetcher?: StudioFetch) {
  return (path: string, init?: RequestInit): Promise<Response> =>
    studioFetch(tenantRuntimePath(tenantId) + path, init, fetcher);
}

/**
 * SDK client for one Tenant through the Studio server. The SDK requires a
 * key; the placeholder is removed before each request (an embedded session's
 * `fetch` then adds its bearer), and the server adds the Tenant's Studio key.
 */
export function createTenantClient(
  tenantId: string,
  options?: Readonly<{ origin?: string; fetcher?: StudioFetch }>,
) {
  const fetcher = options?.fetcher ?? sessionFetch();
  return createClient({
    url: (options?.origin ?? location.origin) + tenantRuntimePath(tenantId),
    key: "studio-session",
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      return fetcher(input, { ...init, headers, credentials: "same-origin" });
    },
  });
}

/**
 * Management API client (`/v1/tenant/*`) for one Tenant through the Studio
 * server. It sends no key: an embedded session's `fetch` adds its bearer, and
 * the server adds Studio's key, which acts as itself there.
 */
export function createTenantManagementClient(
  tenantId: string,
  options?: Readonly<{ origin?: string; fetcher?: StudioFetch }>,
) {
  const fetcher = options?.fetcher ?? sessionFetch();
  return createManagementClient({
    url: (options?.origin ?? location.origin) + tenantRuntimePath(tenantId),
    fetch: (input, init) => fetcher(input, { ...init, credentials: "same-origin" }),
  });
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (response.status === 401) throw new StudioSignedOutError();
  if (!response.ok) {
    let message = `${what} failed (${response.status}).`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message) message = body.message;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** Studio's version, the Runtime's compatibility and the installation's Tenant. */
export async function fetchHello(fetcher?: StudioFetch): Promise<StudioHello> {
  return readJson<StudioHello>(
    await studioFetch("/_studio/hello", undefined, fetcher),
    "Studio hello",
  );
}
