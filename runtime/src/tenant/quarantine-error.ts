import type { Quarantine } from "./types.js";

/** Typed quarantine raised while opening a Tenant Runtime (A7). */
export class QuarantineError extends Error {
  readonly quarantine: Quarantine;

  constructor(
    code: Quarantine["code"],
    message: string,
    repair = "nylo tenant status",
  ) {
    super(message);
    this.name = "QuarantineError";
    this.quarantine = { code, message, repair };
  }
}
