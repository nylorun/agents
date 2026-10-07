/**
 * HTTP tools (R2 M3): a tool the manifest describes as one HTTP request, made by the Tool Gate.
 * The loop names the tool; the gate finds its URL, method and credential in the session's pinned
 * manifest, as it finds a remote MCP server, so the loop never chooses a URL or a credential.
 *
 * `callHttpTarget` is the request and its answer, for any declared HTTP target: the input as a
 * JSON body under the Host's address policy (`tenant/outbound.ts`), a 2xx answer as the output
 * (JSON, or text when the answer is not JSON and no output schema asks for JSON), and every other
 * answer, a timeout or a refused address as a failed outcome the model sees. `runHttpTool` adds
 * what a tool call needs: the declaration, the vault credential and the identity headers.
 *
 * A flow's HTTP stages and HTTP verifiers (R2) are called the same way: the ref names the flow
 * session and the stage key, and the gate finds the target in the pinned workflow manifest. The
 * `Nylorun-Agent-Id` is the flow agent's.
 */
import {
  AGENT_ID_HEADER,
  SESSION_ID_HEADER,
  TURN_ID_HEADER,
} from "@nylorun/core/compatibility";
import {
  HTTP_TOOL_DEFAULT_TIMEOUT_MS,
  delegateManifest,
  flowHttpTarget,
  isWorkflowManifest,
  schemaFromJSON,
  type AgentManifest,
  type HttpToolTarget,
  type JsonObject,
  type ToolManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { MAX_RESPONSE_BYTES, post, type OutboundPolicy } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import type { AuthorizeResult } from "../vault/service.js";
import type { McpCredentialRequest } from "../vault/sources.js";
import type { TenantVaults } from "./tenant-vaults.js";

/** How much of a failed answer's body the model sees. */
export const HTTP_ERROR_BODY_CHARS = 2_000;

/** What an HTTP request came to, as a tool outcome. */
export type HttpOutcome =
  | { readonly kind: "completed"; readonly output: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/**
 * One declared HTTP tool of a session: what the gate finds it by in the pinned manifest. An
 * agent's HTTP tool is named by its capability and tool; a flow's HTTP stage or HTTP verifier
 * by its stage key.
 */
export type HttpToolRef =
  | {
      readonly sessionId: string;
      /** The agent used as a tool that declares it; absent for the session's root agent. */
      readonly agentId?: string;
      readonly capabilityId: string;
      readonly toolName: string;
    }
  | {
      readonly sessionId: string;
      /** The stage key of a flow's HTTP stage or HTTP verifier. */
      readonly stage: string;
    };

/** One call of an HTTP tool. `effectId` is its run-once key, sent as `Idempotency-Key`. */
export interface HttpToolCall {
  readonly tool: HttpToolRef;
  readonly effectId: string;
  readonly turnId: string;
  readonly input: unknown;
}

/** What `runHttpTool` reads of the Tenant: the session's pinned manifest and its credentials. */
export interface HttpToolTenant {
  session(sessionId: string): Promise<{ readonly manifest: unknown } | undefined>;
  authorize(sessionId: string, request: McpCredentialRequest): Promise<AuthorizeResult>;
}

/** The HTTP tool `capabilityId`/`toolName` of the agent `agentId` (the root when absent). */
export function declaredHttpTool(
  manifest: unknown,
  agentId: string | undefined,
  capabilityId: string | undefined,
  toolName: string | undefined,
): (ToolManifest & { readonly http: HttpToolTarget }) | undefined {
  const root = manifest as AgentManifest | undefined;
  if (!root || !Array.isArray(root.capabilities)) return undefined;
  const agent = agentId === undefined ? root : delegateManifest(root, agentId);
  const tool = agent?.capabilities
    .find((capability) => capability.id === capabilityId)
    ?.tools?.find((item) => item.name === toolName);
  return tool?.http ? (tool as ToolManifest & { http: HttpToolTarget }) : undefined;
}

/** The HTTP stage or HTTP verifier at stage key `stage` of a flow session's `manifest`. */
export function declaredFlowHttp(manifest: unknown, stage: string | undefined) {
  return stage !== undefined && isWorkflowManifest(manifest as WorkflowManifest | undefined)
    ? flowHttpTarget(manifest as WorkflowManifest, stage)
    : undefined;
}

/**
 * True when `request` calls an HTTP tool the session's `manifest` declares, or runs one of a
 * flow's HTTP stages or HTTP verifiers (a flow `tool` effect, named by its stage key).
 */
export function isHttpToolCall(manifest: unknown, request: HostEffect): boolean {
  if (request.kind !== "tool") return false;
  if (request.capabilityId === undefined) return declaredFlowHttp(manifest, request.key) !== undefined;
  return declaredHttpTool(manifest, request.agent?.id, request.capabilityId, request.toolName) !== undefined;
}

/** The ref a `tool` effect calls the Tool Gate with: its agent's HTTP tool, or its flow stage. */
export function httpToolRefOf(request: HostEffect): HttpToolRef {
  if (request.capabilityId === undefined) return { sessionId: request.sessionId, stage: request.key! };
  return {
    sessionId: request.sessionId,
    ...(request.agent ? { agentId: request.agent.id } : {}),
    capabilityId: request.capabilityId,
    toolName: request.toolName!,
  };
}

/**
 * Sends `input` to `target` and reads the answer. Never throws: everything that can happen to
 * the request is an outcome. Rejects only when `signal` aborts, with its reason.
 */
export async function callHttpTarget(
  target: HttpToolTarget,
  input: unknown,
  options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly policy: OutboundPolicy;
    readonly signal: AbortSignal;
    /** Checked against the answer; a mismatch is `tool.invalid-output`. */
    readonly outputSchema?: JsonObject;
  },
): Promise<HttpOutcome> {
  const timeoutMs = target.timeoutMs ?? HTTP_TOOL_DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const result = await post(target.url, JSON.stringify(input ?? {}), { ...options.headers }, {
    policy: options.policy,
    method: target.method ?? "POST",
    signal: AbortSignal.any([options.signal, timeout]),
  });
  if (options.signal.aborted) throw options.signal.reason;
  if (timeout.aborted) return failed("http.timeout", `The service did not answer within ${timeoutMs} ms`);
  switch (result.kind) {
    case "not_sent":
      return result.code === "ENDPOINT_ADDRESS_REFUSED"
        ? failed("http.refused", result.message)
        : failed("http.unreachable", `The request was not sent: ${result.message}`);
    case "lost":
      return failed(
        "http.lost",
        `The connection was lost after the request was sent, so the call may have run: ${result.message}`,
      );
    case "too_large":
      return failed("http.too-large", `The answer (HTTP ${result.status}) is larger than ${MAX_RESPONSE_BYTES} bytes`);
  }
  const text = result.body.toString("utf8");
  if (result.status < 200 || result.status > 299) {
    const body = text.length > HTTP_ERROR_BODY_CHARS ? `${text.slice(0, HTTP_ERROR_BODY_CHARS)}…` : text;
    return failed("http.status", `The service answered HTTP ${result.status}${body ? `: ${body}` : ""}`);
  }
  const type = String(result.headers["content-type"] ?? "");
  let output: unknown;
  if (text === "") output = null;
  else if (/[/+]json\b/i.test(type)) {
    try {
      output = JSON.parse(text);
    } catch {
      return failed("http.invalid-response", "The answer says it is JSON but does not parse");
    }
  } else if (options.outputSchema)
    return failed(
      "http.invalid-response",
      `The answer is ${type || "untyped"}, not JSON, and the tool's output schema needs JSON`,
    );
  else output = text;
  if (!options.outputSchema) return { kind: "completed", output };
  const checked = schemaFromJSON(options.outputSchema).validate(output);
  if (!checked.ok)
    return failed("tool.invalid-output", checked.issues.map((issue) => issue.message).join("; "));
  return { kind: "completed", output: checked.value };
}

/**
 * Runs one HTTP tool call of a session: finds the tool in the pinned manifest, adds its vault
 * credential, the identity headers and the run-once key, and calls it. Never throws but for an
 * abort of `signal`. Logs one line per call, never the input, the answer or a credential.
 */
export async function runHttpTool(
  tenant: HttpToolTenant,
  call: HttpToolCall,
  options: { readonly policy: OutboundPolicy; readonly signal: AbortSignal; readonly logger?: Logger },
): Promise<HttpOutcome> {
  const started = Date.now();
  const { tool } = call;
  let outcome: HttpOutcome;
  try {
    outcome = await run();
  } catch (error) {
    if (options.signal.aborted) throw error;
    outcome = failed("http.failed", error instanceof Error ? error.message : String(error));
  }
  options.logger?.info("http_tool_call", {
    session: tool.sessionId,
    ...("stage" in tool
      ? { stage: tool.stage }
      : {
          capability: tool.capabilityId,
          tool: tool.toolName,
          ...(tool.agentId === undefined ? {} : { agent: tool.agentId }),
        }),
    effect: call.effectId,
    ms: Date.now() - started,
    outcome: outcome.kind === "completed" ? "ok" : outcome.code,
  });
  return outcome;

  async function run(): Promise<HttpOutcome> {
    const session = await tenant.session(tool.sessionId);
    if (!session) return failed("http.undeclared", `Session ${tool.sessionId} not found`);
    const agentId = "stage" in tool ? undefined : tool.agentId;
    const declared =
      "stage" in tool
        ? declaredFlowHttp(session.manifest, tool.stage)
        : declaredHttpTool(session.manifest, agentId, tool.capabilityId, tool.toolName);
    if (!declared)
      return failed(
        "http.undeclared",
        "stage" in tool
          ? `'${tool.stage}' is not an HTTP stage of the flow`
          : `'${tool.toolName}' is not an HTTP tool of the session`,
      );
    const { http } = declared;
    let credential: Record<string, string> = {};
    if (http.credential !== undefined) {
      const authorized = await tenant.authorize(tool.sessionId, {
        url: http.url,
        serverName: http.credential,
      });
      if (authorized.status === "refused")
        return failed("http.credential", `The credential '${http.credential}' was refused: ${authorized.reason}`);
      if (authorized.status === "unauthenticated")
        return failed(
          "http.credential",
          `The session's vaults hold no credential '${http.credential}' for ${authorized.url}`,
        );
      credential = authorized.headers;
    }
    return callHttpTarget(http, call.input, {
      headers: {
        ...credential,
        [SESSION_ID_HEADER]: tool.sessionId,
        [TURN_ID_HEADER]: call.turnId,
        [AGENT_ID_HEADER]: agentId ?? (session.manifest as AgentManifest).id,
        "idempotency-key": call.effectId,
      },
      policy: options.policy,
      signal: options.signal,
      ...(declared.outputSchema === undefined ? {} : { outputSchema: declared.outputSchema }),
    });
  }
}

/** The gates service's HTTP tool calls, with the Tenant's vault (`host/gates.ts`). */
export function gateHttpTools(vaults: TenantVaults, policy: OutboundPolicy, logger: Logger) {
  return {
    call: (tenantId: string | undefined, call: HttpToolCall, signal: AbortSignal) =>
      runHttpTool(
        {
          session: async (sessionId) => (await vaults.open(tenantId)).session(sessionId),
          authorize: async (sessionId, request) =>
            (await vaults.open(tenantId)).authorizeMcp(sessionId, request),
        },
        call,
        { policy, signal, logger },
      ),
  };
}

function failed(code: string, message: string): HttpOutcome {
  return { kind: "failed", code, message };
}
