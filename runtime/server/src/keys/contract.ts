/**
 * The `keys` service's wire format (F4.2): `POST /nylorun/v1/keys/{operation}` with
 * `{args}`, the operation's arguments in order, on the gateway's listener with the stack's
 * gates token. Internal: only core calls it, so it is not in the published OpenAPI documents.
 *
 * `200 {result}` when the operation succeeded, `200 {error}` when it refused: a vault error or
 * a Tenant API error with its status, code and details, so the route that called it answers
 * exactly what it answered when the operation ran in its own process.
 */
export const KEYS_PATH = "/nylorun/v1/keys";

/** Largest request body: a credential with its secret, or a token's claims. */
export const MAX_KEYS_BODY_BYTES = 1024 * 1024;

export interface KeysError {
  readonly kind: "vault" | "http";
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}

export type KeysAnswer = { readonly result: unknown } | { readonly error: KeysError };
