export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The rejection's code and details, when the answer carries one (`credential_conflict`). */
    readonly rejection: { readonly code?: string; readonly details?: Record<string, unknown> } = {},
  ) {
    super(message);
  }
}
