/**
 * How the CLI names itself to the Runtime, for the Runtime's telemetry (`nylorun.client=cli`,
 * ADR-159): the `Nylorun-Client` header on every request it sends, replacing the label the SDKs
 * it uses would send (`sdk`).
 */

/** The header and the CLI's label. */
export const CLIENT_LABEL = { "Nylorun-Client": "cli" } as const;

/** `fetch` that labels every request as the CLI's. */
export function labelledFetch(fetch: (input: string, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(CLIENT_LABEL)) headers.set(name, value);
    return fetch(input instanceof Request ? input.url : String(input), { ...init, headers });
  };
}
