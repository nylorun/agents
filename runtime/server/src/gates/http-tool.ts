/**
 * HTTP tools (R2 M3): a tool the manifest describes as one HTTP request, made by the Tool Gate.
 * The loop names the tool; the gate finds its URL, method and credential in the session's pinned
 * manifest, as it finds a remote MCP server, so the loop never chooses a URL or a credential.
 *
 * `callHttpTarget` is the request and its answer, for any declared HTTP target: the input as
 * core's `httpToolRequest` maps it (path parameters in the URL, the rest as a JSON body or, for
 * `GET` and `DELETE`, the query string) under the Host's address policy (`tenant/outbound.ts`),
 * a 2xx answer as the output
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
  delegatesOf,
  flowHttpTarget,
  httpPathParameters,
  httpToolRequest,
  isWorkflowManifest,
  schemaFromJSON,
  type AgentManifest,
  type HttpToolTarget,
  type JsonObject,
  type ToolManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import type { RuntimeLimits } from "@nylorun/core/contracts";
import { scrubValues } from "../redact.js";
import { send, type OutboundPolicy } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import { credentialSecrets } from "../vault/headers.js";
import type { AuthorizeResult } from "../vault/service.js";
import type { McpCredentialRequest } from "../vault/sources.js";
import type { TenantVaults } from "./tenant-vaults.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";

/** What an HTTP request came to, as a tool outcome. */
export type HttpOutcome =
  | {
      readonly kind: "completed";
      readonly output: unknown;
      /** How many credential values the answer echoed, replaced with `[redacted]` (R2b C8). */
      readonly redacted?: number;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
      /** With `credential_rejected`: the tool's `credential`. */
      readonly server?: string;
      /** How many credential values the message had in it, replaced (R2b C8). */
      readonly redacted?: number;
    };

/**
 * One declared HTTP tool of a session: what the gate finds it by in the pinned manifest. An
 * agent's HTTP tool is named by its agent and tool name; a flow's HTTP stage or HTTP verifier
 * by its stage key.
 */
export type HttpToolRef =
  | {
      readonly sessionId: string;
      /** The agent used as a tool that declares it; absent for the session's root agent. */
      readonly agentId?: string;
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
  /**
   * The call's span context (R7.4), sent as `traceparent`: in the gates service, from the call's
   * journal row (`gates/journal.ts`); in process, from core's `execute` answer. Never a body field.
   */
  readonly traceparent?: string;
}

/**
 * What `runHttpTool` reads of the Tenant: the session's pinned manifest, its credentials, and its
 * Runtime limits (`toolAnswerBytes`, `httpToolTimeoutMs`, `errorExcerptChars`), read for each call.
 */
export interface HttpToolTenant {
  session(sessionId: string): Promise<{ readonly manifest: unknown } | undefined>;
  authorize(sessionId: string, request: McpCredentialRequest): Promise<AuthorizeResult>;
  limits(): Promise<HttpToolLimits>;
}

/** The Runtime limits an HTTP tool call keeps to. */
export type HttpToolLimits = Pick<RuntimeLimits, "toolAnswerBytes" | "httpToolTimeoutMs" | "errorExcerptChars">;

/** The HTTP tool `toolName` of the agent `agentId` (the root when absent). */
export function declaredHttpTool(
  manifest: unknown,
  agentId: string | undefined,
  toolName: string | undefined,
): (ToolManifest & { readonly http: HttpToolTarget }) | undefined {
  const root = manifest as AgentManifest | undefined;
  if (!root || typeof root !== "object" || isWorkflowManifest(root as never) || toolName === undefined)
    return undefined;
  const agent = agentId === undefined ? root : delegateManifest(root, agentId);
  const tool = agent?.tools?.find((item) => item.name === toolName);
  return tool?.http ? (tool as ToolManifest & { http: HttpToolTarget }) : undefined;
}

/**
 * Why `manifest` cannot be deployed: each HTTP tool of it, or of an agent it uses as a tool, whose
 * `timeoutMs` is longer than the Tenant's Runtime limit `httpToolTimeoutMs`. A call also waits at
 * most the limit in force then (`callHttpTarget`).
 */
export function httpToolTimeoutIssues(manifest: unknown, limitMs: number): string[] {
  const root = manifest as AgentManifest | undefined;
  if (!root || typeof root !== "object" || isWorkflowManifest(root as never)) return [];
  return [root, ...delegatesOf(root).map((delegate) => delegate.manifest)].flatMap((agent) =>
    (agent.tools ?? []).flatMap((tool) => {
      const asked = tool.http?.timeoutMs;
      return asked !== undefined && asked > limitMs
        ? [
            `HTTP tool '${tool.name}' of agent '${agent.id}' asks for timeoutMs ${asked}; the Runtime limit httpToolTimeoutMs allows at most ${limitMs} (PUT /v1/tenant/limits).`,
          ]
        : [];
    }),
  );
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
  // An agent's call names what runs it (protocol 15): an `http` call names its declared tool.
  if (request.target?.kind === "http")
    return declaredHttpTool(manifest, request.agent?.id, request.target.tool) !== undefined;
  if (request.target === undefined && request.toolName === undefined)
    return declaredFlowHttp(manifest, request.key) !== undefined;
  return false;
}

/**
 * The ref a `tool` effect calls the Tool Gate with: its agent's HTTP tool, by the declared name
 * its target names, or its flow stage.
 */
export function httpToolRefOf(request: HostEffect): HttpToolRef {
  if (request.target?.kind !== "http") return { sessionId: request.sessionId, stage: request.key! };
  return {
    sessionId: request.sessionId,
    ...(request.agent ? { agentId: request.agent.id } : {}),
    toolName: request.target.tool,
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
    /**
     * The Tenant's Runtime limits: the largest answer read (`toolAnswerBytes`; past it,
     * `http.too-large`), the longest the tool may wait (`httpToolTimeoutMs`, which its own
     * `timeoutMs` may not pass) and how much of an error answer is quoted (`errorExcerptChars`).
     */
    readonly limits: HttpToolLimits;
    /** Checked against the answer; a mismatch is `tool.invalid-output`. */
    readonly outputSchema?: JsonObject;
  },
): Promise<HttpOutcome> {
  const request = httpToolRequest(target, input);
  if ("issue" in request) return failed("tool.invalid-input", request.issue);
  const { limits } = options;
  const timeoutMs = Math.min(target.timeoutMs ?? HTTP_TOOL_DEFAULT_TIMEOUT_MS, limits.httpToolTimeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  const result = await send(request.url, request.body, { ...options.headers }, {
    policy: options.policy,
    method: request.method,
    signal: AbortSignal.any([options.signal, timeout]),
    maxResponseBytes: limits.toolAnswerBytes,
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
      return failed(
        "http.too-large",
        `The answer (HTTP ${result.status}) is larger than ${limits.toolAnswerBytes} bytes (the Runtime limit toolAnswerBytes)`,
      );
  }
  // The service answered, so the outcome is known; never retried, and its body is not shown (R2b C1).
  if (result.status === 401)
    return failed("credential_rejected", "The service answered HTTP 401: it rejected the credential, or needs one");
  const text = result.body.toString("utf8");
  if (result.status < 200 || result.status > 299) {
    const chars = limits.errorExcerptChars;
    const body = text.length > chars ? `${text.slice(0, chars)}…` : text;
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
        : declaredHttpTool(session.manifest, agentId, tool.toolName);
    if (!declared)
      return failed(
        "http.undeclared",
        "stage" in tool
          ? `'${tool.stage}' is not an HTTP stage of the flow`
          : `'${tool.toolName}' is not an HTTP tool of the session`,
      );
    const { http } = declared;
    let credential: Record<string, string> = {};
    let identity: { readonly header: string } | undefined;
    let target: HttpToolTarget = http;
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
          `The session's Environment holds no credential '${http.credential}' for ${authorized.url}`,
        );
      credential = authorized.headers;
      identity = authorized.identity;
      // A credential with `via` sends the call there, a gateway (R2b C2, Q9): to its one URL, so
      // it has no place for the tool's URL parameters.
      if (authorized.via !== undefined && httpPathParameters(http.url).length > 0)
        return failed(
          "http.credential",
          `The credential '${http.credential}' sends calls to its via URL, which cannot take the tool's {field} URL parameters`,
        );
      if (authorized.via !== undefined) target = { ...http, url: authorized.via };
    }
    const answered = await callHttpTarget(target, call.input, {
      headers: {
        ...credential,
        [SESSION_ID_HEADER]: tool.sessionId,
        [TURN_ID_HEADER]: call.turnId,
        [AGENT_ID_HEADER]: agentId ?? (session.manifest as AgentManifest).id,
        "idempotency-key": call.effectId,
        ...(call.traceparent ? { traceparent: call.traceparent } : {}),
      },
      policy: options.policy,
      signal: options.signal,
      limits: await tenant.limits(),
      ...(declared.outputSchema === undefined ? {} : { outputSchema: declared.outputSchema }),
    });
    // Nothing the service echoes of the credential reaches the model, an event or the gate's
    // record of the call: its answer and the start of an error body alike (R2b C8).
    const outcome = scrubbedOutcome(answered, credentialSecrets(credential, identity));
    if (outcome.kind !== "failed" || outcome.code !== "credential_rejected" || http.credential === undefined)
      return outcome;
    return {
      ...outcome,
      message: `The service answered HTTP 401: it rejected the credential '${http.credential}' from the session's Environment`,
      server: http.credential,
    };
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
          limits: async () => (await vaults.open(tenantId)).store.tx((t) => readRuntimeLimits(t)),
        },
        call,
        { policy, signal, logger },
      ),
  };
}

function failed(code: string, message: string): HttpOutcome {
  return { kind: "failed", code, message };
}

/** `outcome` with each of `secrets` replaced by `[redacted]`, and how many were. */
function scrubbedOutcome(outcome: HttpOutcome, secrets: readonly string[]): HttpOutcome {
  if (outcome.kind === "completed") {
    const output = scrubValues(outcome.output, secrets);
    return output.redacted === 0 ? outcome : { ...outcome, output: output.value, redacted: output.redacted };
  }
  const message = scrubValues(outcome.message, secrets);
  return message.redacted === 0 ? outcome : { ...outcome, message: message.value, redacted: message.redacted };
}
