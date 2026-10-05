import type { BuildDiagnostic } from "../../types/shared.js";

/** Thrown when a flow agent fails its build-time checks. */
export class WorkflowBuildError extends Error {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(
      diagnostics.map((item) => item.message).join("; ") || "Workflow build failed",
    );
    this.name = "WorkflowBuildError";
  }
}

export function diagnostic(
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic {
  return Object.freeze({ code, message, ...extra });
}

export function fail(diagnostics: readonly BuildDiagnostic[]): never {
  throw new WorkflowBuildError(Object.freeze([...diagnostics]));
}
