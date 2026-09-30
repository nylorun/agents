/**
 * Action-scoped sandbox client (`ctx.sandbox`). Calls `POST /v1/actions/:id/sandbox/:tool`
 * with an executor's live claim, or, for a delivery to an Action endpoint, over a transport
 * whose credential is the delivery token.
 */
import {
  SANDBOX_TOOL_NAMES,
  type SandboxToolName,
} from "@nylorun/core/define";
import { segment, type Transport } from "../http.js";

export type ActionSandboxToolResult =
  | { readonly kind: "completed"; readonly output: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

export type ActionSandbox = {
  readonly bash: (input: {
    command: string;
    timeout?: number;
  }) => Promise<ActionSandboxToolResult>;
  readonly read: (input: {
    path: string;
    offset?: number;
    limit?: number;
  }) => Promise<ActionSandboxToolResult>;
  readonly write: (input: {
    path: string;
    content: string;
  }) => Promise<ActionSandboxToolResult>;
  readonly edit: (input: {
    path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }) => Promise<ActionSandboxToolResult>;
  readonly grep: (input: {
    pattern: string;
    path?: string;
    glob?: string;
    ignore_case?: boolean;
    max_results?: number;
  }) => Promise<ActionSandboxToolResult>;
  readonly glob: (input: {
    pattern: string;
    path?: string;
  }) => Promise<ActionSandboxToolResult>;
};

export type CreateActionSandboxOptions = {
  readonly transport: Transport;
  readonly actionId: string;
  readonly signal?: AbortSignal;
} & (
  | { readonly claimId: string; readonly generation: number }
  /** A delivery: the transport's key is the delivery token, which names the generation. */
  | { readonly claimId?: undefined; readonly generation?: undefined }
);

/** Build `ctx.sandbox` for one claimed or delivered action. Callers skip it when the session has none. */
export function createActionSandbox(
  options: CreateActionSandboxOptions
): ActionSandbox {
  const call = (tool: SandboxToolName, input: Record<string, unknown>) =>
    options.transport.json<ActionSandboxToolResult>(
      `/v1/actions/${segment(options.actionId)}/sandbox/${tool}`,
      "POST",
      options.claimId === undefined
        ? input
        : { claimId: options.claimId, generation: options.generation, ...input },
      options.signal
    );

  const sandbox = {
    bash: (input: { command: string; timeout?: number }) => call("bash", input),
    read: (input: { path: string; offset?: number; limit?: number }) =>
      call("read", input),
    write: (input: { path: string; content: string }) => call("write", input),
    edit: (input: {
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }) => call("edit", input),
    grep: (input: {
      pattern: string;
      path?: string;
      glob?: string;
      ignore_case?: boolean;
      max_results?: number;
    }) => call("grep", input),
    glob: (input: { pattern: string; path?: string }) => call("glob", input),
  } satisfies ActionSandbox;

  // Freeze so tools cannot replace built-ins.
  return Object.freeze(sandbox);
}

export function isActionSandboxTool(name: string): name is SandboxToolName {
  return (SANDBOX_TOOL_NAMES as readonly string[]).includes(name);
}

/** True when the executable declares a sandbox the Runtime can share. */
export function definitionDeclaresSandbox(
  manifest: { kind?: string; sandbox?: unknown; capabilities?: readonly { sandbox?: unknown }[] }
): boolean {
  if (manifest.kind === "workflow") return manifest.sandbox !== undefined;
  return (manifest.capabilities ?? []).some((item) => item.sandbox !== undefined);
}
