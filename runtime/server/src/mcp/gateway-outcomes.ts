/**
 * A gateway's report that the server behind it refused its credential (#495). A gateway that holds
 * people's tokens may answer an upstream `401` with HTTP 200: LiteLLM lists no tools and names the
 * outcome in the answer's `_meta`, and fails a tool call with `isError` and the upstream error's
 * text. Only answers that came through a credential's `via` are read so: a server the Runtime talks
 * to directly says `401` itself.
 */

/** LiteLLM's outcome per server it reached: `{ status: "auth_required", http_status: 401 }`. */
const LITELLM_SERVER_OUTCOMES = "litellm.ai/server_outcomes";

/** LiteLLM's text for a tool call the upstream server answered `401` (httpx's error message). */
const LITELLM_UNAUTHORIZED_TEXT = /HTTPStatusError: Client error '401 Unauthorized'/;

/** The names a gateway may give the server under: the manifest's first, then any others. */
export type GatewayServerKeys = readonly string[];

/**
 * Whether a `tools/list` page or a `tools/call` result reports that the server behind the
 * gateway refused the credential. A call's text is read only when the result is an error.
 */
export function gatewayAuthFailure(answer: unknown, keys: GatewayServerKeys): boolean {
  if (!isRecord(answer)) return false;
  const outcome = serverOutcome(answer._meta, keys);
  if (outcome && (outcome.status === "auth_required" || outcome.http_status === 401)) return true;
  return answer.isError === true && LITELLM_UNAUTHORIZED_TEXT.test(textOf(answer.content));
}

/** The gateway's outcome for this server: the entry one of `keys` names, else the only entry. */
function serverOutcome(meta: unknown, keys: GatewayServerKeys): Record<string, unknown> | undefined {
  if (!isRecord(meta)) return undefined;
  const outcomes = meta[LITELLM_SERVER_OUTCOMES];
  if (!isRecord(outcomes)) return undefined;
  for (const key of keys) if (isRecord(outcomes[key])) return outcomes[key];
  const entries = Object.values(outcomes);
  return entries.length === 1 && isRecord(entries[0]) ? entries[0] : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
