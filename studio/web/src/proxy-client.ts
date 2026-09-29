/**
 * Same-origin client for the Studio server. The browser holds only the
 * HttpOnly session cookie; the server adds every Runtime credential.
 */
import { createClient } from "@nylorun/agents/client";

export type StudioFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type StudioTenant = Readonly<{
  id: string;
  name: string | null;
  state: string;
}>;

export type StudioHello = Readonly<{
  version: string;
  runtime: Readonly<{ compatible: boolean; message?: string }>;
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

/** Same-origin fetch with the session cookie. Accepts only absolute paths. */
export function studioFetch(
  path: string,
  init?: RequestInit,
  fetcher: StudioFetch = fetch,
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
 * key; the placeholder is removed before each request, and the server adds
 * the Tenant's Studio key.
 */
export function createTenantClient(
  tenantId: string,
  options?: Readonly<{ origin?: string; fetcher?: StudioFetch }>,
) {
  const fetcher = options?.fetcher ?? fetch;
  return createClient({
    url: (options?.origin ?? location.origin) + tenantRuntimePath(tenantId),
    key: "studio-session",
    tenant: tenantId,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      return fetcher(input, { ...init, headers, credentials: "same-origin" });
    },
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

export async function fetchHello(fetcher?: StudioFetch): Promise<StudioHello> {
  return readJson<StudioHello>(
    await studioFetch("/_studio/hello", undefined, fetcher),
    "Studio hello",
  );
}

/**
 * Create a Tenant through the Studio server. It registers the derived
 * principal `project`, so a Project on this machine can link it with
 * `nylo tenant use <id>`; no key reaches the browser.
 */
export async function createTenant(
  name: string,
  fetcher?: StudioFetch,
): Promise<StudioTenant> {
  const body = await readJson<{ tenant: StudioTenant }>(
    await studioFetch(
      "/_studio/tenants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
      fetcher,
    ),
    "Creating the Tenant",
  );
  return body.tenant;
}

/** The command that links a Project on this machine to a Tenant. */
export function tenantUseCommand(tenantId: string): string {
  return `npx @nylorun/cli tenant use ${tenantId}`;
}

export async function listTenants(
  fetcher?: StudioFetch,
): Promise<readonly StudioTenant[]> {
  const body = await readJson<{ tenants: StudioTenant[] }>(
    await studioFetch("/_studio/tenants", undefined, fetcher),
    "Listing Tenants",
  );
  return body.tenants;
}
