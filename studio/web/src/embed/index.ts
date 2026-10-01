/**
 * Embed mode (Studio §8.7): on when the page was loaded with `?embed=1`.
 * `startEmbed` wires the bridge, the session and the theme once, before the
 * first render; the rest of the dashboard asks `embedded()` and uses the
 * session's `fetch`.
 */
import { startBridge, frameAncestorsFrom, type Bridge, type OutboundMessage } from "./bridge.ts";
import { createEmbedSession, type EmbedSession } from "./session.ts";
import { applyTheme } from "./theme.ts";

let bridge: Bridge | undefined;
let session: EmbedSession | undefined;
const navigateListeners = new Set<(route: string) => void>();
let pendingRoute: string | undefined;

/** True when this page was opened in embed mode. Read once, at load. */
const EMBED =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("embed") === "1";

export function embedded(): boolean {
  return EMBED;
}

export function embedSession(): EmbedSession | undefined {
  return session;
}

export function postToEmbedder(message: OutboundMessage): void {
  bridge?.post(message);
}

/** Registers the router's navigate; a route that arrived earlier is replayed. */
export function onEmbedNavigate(listener: (route: string) => void): () => void {
  navigateListeners.add(listener);
  if (pendingRoute !== undefined) {
    const route = pendingRoute;
    pendingRoute = undefined;
    listener(route);
  }
  return () => navigateListeners.delete(listener);
}

function navigateTo(route: string) {
  if (navigateListeners.size === 0) {
    pendingRoute = route;
    return;
  }
  for (const listener of navigateListeners) listener(route);
}

/** Starts embed mode. Does nothing outside it. */
export function startEmbed(studioVersion: string): void {
  if (!EMBED || bridge !== undefined) return;
  document.documentElement.dataset.embed = "1";
  bridge = startBridge({
    window,
    allowed: frameAncestorsFrom(document),
    studioVersion,
    onMessage(message) {
      switch (message.kind) {
        case "init":
          if (message.theme) applyTheme(message.theme);
          if (message.route && message.route !== location.pathname) navigateTo(message.route);
          void session?.redeem(message.token);
          return;
        case "token.refresh":
          void session?.redeem(message.token);
          return;
        case "theme.changed":
          applyTheme(message.theme);
          return;
        case "navigate":
          navigateTo(message.route);
          return;
      }
    },
  });
  const activeBridge = bridge;
  session = createEmbedSession({
    fetch: (input, init) => fetch(input, init),
    post: (message) => activeBridge.post(message),
  });
  // Links that leave Studio open in the embedder (its browser), not in the frame.
  document.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin) return;
      event.preventDefault();
      if (url.protocol === "http:" || url.protocol === "https:")
        activeBridge.post({ kind: "open.external", url: url.href });
    },
    true,
  );
}
