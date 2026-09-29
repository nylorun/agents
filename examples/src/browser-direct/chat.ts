import { HttpAgent, type BaseEvent } from "@ag-ui/client";
import { createBrowserClient } from "@nylorun/agents/browser";

/**
 * The page's side, written without the DOM so any bundler (Vite, Next.js, …) can use it: read
 * the backend's config, then talk to the Runtime directly with AG-UI. Tokens come from the
 * backend's token route and stay in memory; a run that outlives its token continues.
 */
export async function startChat(options: {
  /** The app's own origin, e.g. `window.location.origin`. */
  appOrigin: string;
  threadId: string;
  onEvent?: (event: BaseEvent) => void;
  /** Defaults to the page's `fetch`; tests pass one that adds what a browser would. */
  fetch?: typeof fetch;
}) {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const config = (await (await send(`${options.appOrigin}/api/nylorun/config`)).json()) as {
    url: string;
    publishableKey: string;
    agentId: string;
  };
  const nylo = createBrowserClient({
    url: config.url,
    publishableKey: config.publishableKey,
    token: async () =>
      (await send(`${options.appOrigin}/api/nylorun/token`, { method: "POST" })).json(),
    fetch: send,
  });
  const { url, fetch } = nylo.agUi(config.agentId);
  const agent = new HttpAgent({
    url,
    fetch,
    threadId: options.threadId,
    initialMessages: (await nylo.agUiHistory(config.agentId, options.threadId)) as never,
  });
  if (options.onEvent) agent.subscribe({ onEvent: ({ event }) => options.onEvent!(event) });
  return { agent, nylo };
}
