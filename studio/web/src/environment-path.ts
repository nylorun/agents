/**
 * Where an Environment lives in Studio: `/environments/<id>` (the id percent-encoded as one
 * segment, since it may hold `/`) with `?tab=`, and where the routes Studio used before point
 * now. An Environment holds its sandbox, its vault's secrets and its disk versions, so its
 * page replaced `/environments?selected=`, the Credentials settings page and `/vault`. No React
 * here, so `node --test` covers it.
 */

/** The tabs of an Environment's page, in order. */
export const ENVIRONMENT_TABS = [
  "overview",
  "secrets",
  "disk",
  "setup",
  "sessions",
  "events",
] as const;
export type EnvironmentTab = (typeof ENVIRONMENT_TABS)[number];

export function isEnvironmentTab(value: unknown): value is EnvironmentTab {
  return ENVIRONMENT_TABS.includes(value as EnvironmentTab);
}

/** `/environments/<id>`, opened on `tab` (the overview when omitted). */
export function environmentPath(id: string, tab?: EnvironmentTab): string {
  const path = `/environments/${encodeURIComponent(id)}`;
  return tab === undefined || tab === "overview" ? path : `${path}?tab=${tab}`;
}

/**
 * What `pathname` names: the list, one Environment (its decoded id), or a segment that is no
 * valid percent-encoding (`invalid`, shown as "not found"). Undefined off `/environments`.
 */
export function environmentRoute(
  pathname: string,
):
  | { kind: "list" }
  | { kind: "environment"; id: string }
  | { kind: "invalid"; segment: string }
  | undefined {
  if (/^\/environments\/?$/u.test(pathname)) return { kind: "list" };
  const segment = pathname.match(/^\/environments\/([^/]+)\/?$/u)?.[1];
  if (segment === undefined) return undefined;
  try {
    return { kind: "environment", id: decodeURIComponent(segment) };
  } catch {
    return { kind: "invalid", segment };
  }
}

/** The tab an old `?tab=` of the Environment inspector names on the page. */
function legacyTab(value: string | null): EnvironmentTab | undefined {
  if (value === "details") return undefined;
  return isEnvironmentTab(value) ? value : undefined;
}

/**
 * Where an old Studio route goes now, keeping the rest of its query; undefined when `pathname`
 * is no old route:
 * - `/environments?selected=<id>&tab=` → `/environments/<id>?tab=`
 * - `/settings/credentials?environment=<id>` and `/vault?environment=<id>` → its Secrets tab
 * - those without an Environment, and `/sandboxes` → `/environments`
 */
export function legacyEnvironmentRedirect(
  pathname: string,
  search: string,
): string | undefined {
  const query = new URLSearchParams(search);
  const rest = (drop: readonly string[]) => {
    for (const key of drop) query.delete(key);
    return query;
  };
  const withQuery = (path: string, extra: URLSearchParams) => {
    const [base, own] = path.split("?");
    const merged = new URLSearchParams(own);
    for (const [key, value] of extra) if (!merged.has(key)) merged.append(key, value);
    const text = merged.toString();
    return text ? `${base}?${text}` : base!;
  };
  if (/^\/environments\/?$/u.test(pathname)) {
    const selected = query.get("selected");
    if (!selected) return undefined;
    const tab = legacyTab(query.get("tab"));
    return withQuery(environmentPath(selected, tab), rest(["selected", "tab"]));
  }
  if (/^\/(?:settings\/credentials|vault)\/?$/u.test(pathname)) {
    const environment = query.get("environment");
    return environment
      ? withQuery(environmentPath(environment, "secrets"), rest(["environment"]))
      : withQuery("/environments", rest(["environment"]));
  }
  if (/^\/sandboxes\/?$/u.test(pathname)) return withQuery("/environments", query);
  return undefined;
}
