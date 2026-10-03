/**
 * Page views to Google Analytics. On only when the server named a measurement
 * id (`<meta name="nylorun-analytics">`, which `nylorun start` sets unless the
 * developer opted out), outside embed mode, and when the browser does not ask
 * not to be tracked. A page view carries the route's shape only: every
 * Tenant, agent and session id becomes `:id`, and the query is dropped.
 */

type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
  interface Navigator {
    globalPrivacyControl?: boolean;
  }
}

/** Path segments kept as they are; any other segment is an id. */
const ROUTE_WORDS = new Set([
  "tenants",
  "agents",
  "sessions",
  "workflows",
  "vault",
  "settings",
  "login",
]);

/** The route's shape: `/tenants/t_1/agents/support/sessions/s_1?x` → `/tenants/:id/agents/:id/sessions/:id`. */
export function pagePath(pathname: string): string {
  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (ROUTE_WORDS.has(segment) ? segment : ":id"));
  return `/${segments.join("/")}`;
}

/** The measurement id from `index.html`, or undefined when analytics is off. */
export function analyticsId(doc: Pick<Document, "querySelector">): string | undefined {
  const content = doc
    .querySelector<HTMLMetaElement>('meta[name="nylorun-analytics"]')
    ?.content.trim();
  return content && /^G-[A-Z0-9]{4,20}$/.test(content) ? content : undefined;
}

let gtag: Gtag | undefined;

/** Loads Google's tag once; does nothing when analytics is off. */
export function startAnalytics(options: { embedded: boolean; studioVersion: string }): void {
  if (gtag !== undefined || options.embedded) return;
  if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true) return;
  const id = analyticsId(document);
  if (id === undefined) return;
  window.dataLayer = window.dataLayer ?? [];
  gtag = function () {
    // gtag.js reads `arguments` objects from the data layer, not arrays.
    window.dataLayer!.push(arguments);
  };
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("set", {
    page_location: pageLocation(location.pathname),
    page_referrer: "",
  });
  gtag("config", id, {
    // `trackPageView` sends each page view with the route's shape only.
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    studio_version: options.studioVersion,
  });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(script);
}

function pageLocation(pathname: string): string {
  return `http://localhost${pagePath(pathname)}`;
}

/** Reports a page view of `pathname` (the full path, with the Tenant). */
export function trackPageView(pathname: string): void {
  if (gtag === undefined) return;
  const path = pagePath(pathname);
  // `set` first, so events Google's tag collects on its own carry the shape too.
  gtag("set", { page_location: pageLocation(pathname), page_title: document.title });
  gtag("event", "page_view", { page_path: path });
}
