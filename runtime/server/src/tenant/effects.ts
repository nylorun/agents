/**
 * Core's side of effects: `resolveNewFlowEffect` journals and dispatches new workflow effects
 * (linked agent sessions; a tool node without `http` fails, as it would run the developer's
 * code); the takeover helpers say which calls their gate recovers. Also vault authorization
 * for MCP servers and HTTP tools. The journal of a run's effects is `harness-api/record.ts`; a
 * harness readies the session's MCP servers itself (`session.mcp`).
 *
 * Every journal write runs in a transaction that locks the effect's session first and checks
 * the advance's ownership epoch (`ownedSession`): after another Worker takes over, the next
 * write throws `ownership.lost` and nothing is written. The model, MCP, HTTP, sandbox and vault
 * calls run between transactions, never inside one.
 */
import type { EffectOutcome, SessionCommand } from "@nylorun/core/contracts";
import type { EffectResolution, HostEffect } from "@nylorun/harness/run";
import type { AgentManifest, JsonValue, SandboxManifest } from "@nylorun/core/define";
import {
  embeddedAgent,
  flowDelegateManifest,
  hashManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";
import {
  countActiveFlowWork,
  deriveAgentEffectSessionId,
  isFlowToolEffect,
  isWorkflowManifest,
  linkedMessageInput,
  linkedMessageKey,
  linkedTurnEnd,
  settleAgentEffect,
  type FlowEffect,
} from "../core/flow-host.js";
import { mayDispatchMore } from "../core/limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import type { Tx } from "../store/types.js";
import type { AuthorizeResult } from "../vault/service.js";
import { sessionCredentials, type McpCredentialRequest } from "../vault/sources.js";
import { isRemoteMcpCall } from "../harness/calls.js";
import { isHttpToolCall } from "../gates/http-tool.js";
import {
  loadSession,
  ownedSession,
  sessionOf,
  type Lease,
  type Session,
  type TenantContext,
} from "./context.js";
import { fail } from "./http.js";
import { turnManifestOf } from "./session.js";
import { command } from "./commands.js";

/**
 * The outcome of a flow `agent` effect once the linked turn it started ended, or undefined
 * while it has not. The linked session may still show an earlier iteration's turn.
 */
export async function linkedOutcome(
  t: Tx,
  effect: { request: HostEffect; agentSessionId?: string },
  agent: Session | undefined
): Promise<EffectOutcome | undefined> {
  const end = await linkedTurnEnd(t, effect, agent);
  if (!end || !agent) return undefined;
  if (end.status === "completed") return { value: end.output };
  return {
    value: {
      kind: "failed",
      code: `agent.${end.status}`,
      message:
        end.error ??
        (end.status === "failed"
          ? "Agent turn failed"
          : "Agent turn was cancelled"),
    },
  };
}

/**
 * True when this Tenant's remote MCP and HTTP tool calls outlive the process that sent them
 * (the gates service, F4.1 G3): after a takeover or a shutdown, the journaled call is re-sent
 * and joins the running call or gets its answer, instead of becoming `uncertain`.
 */
export function recoversToolCalls(ctx: TenantContext): boolean {
  return ctx.toolGate.recovers === true;
}

/** True when `request` calls a tool of a declared MCP server (every one is remote) or an HTTP tool. */
export function isGateToolEffect(s: Session, request: HostEffect): boolean {
  return (
    isRemoteMcpCall({ rootManifest: s.manifest }, request) ||
    isHttpToolCall(s.manifest, request)
  );
}

/**
 * True when this Tenant's vault-backed model calls outlive the process that sent them (the
 * gates service, P1.2): after a takeover or a shutdown, the journaled call is re-sent and joins
 * the running call or gets its outcome, instead of becoming `uncertain`.
 */
export function recoversModelCalls(ctx: TenantContext): boolean {
  return ctx.modelGate.recovers === true;
}

type FlowStep =
  | { kind: "resolved"; resolution: EffectResolution }
  | { kind: "agent"; workflow: Session; startedAt: string };

/** Journal and dispatch a new flow effect (agent or tool node). */
export async function resolveNewFlowEffect(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal,
  lease: Lease
): Promise<EffectResolution> {
  const { store } = ctx;
  signal.throwIfAborted();
  const step = await store.tx(async (t): Promise<FlowStep> => {
    const resolved = (resolution: EffectResolution): FlowStep => ({
      kind: "resolved",
      resolution,
    });
    const workflow = await ownedSession(t, lease, request.sessionId);
    const existing = await t.get("effects", request.effectId);
    if (existing) {
      if (existing.status === "completed")
        return resolved({ status: "completed", outcome: existing.outcome });
      if (existing.status === "queued") {
        // Fall through to dispatch when a concurrency slot is free.
      } else if (request.kind === "agent") {
        const agentSessionId = existing.agentSessionId as string | undefined;
        const agent = agentSessionId
          ? await t.get<Session>("sessions", agentSessionId)
          : undefined;
        const outcome = await linkedOutcome(t, existing, agent);
        if (!outcome) return resolved({ status: "pending" });
        await settleAgentEffect({ t, effect: existing as FlowEffect, outcome });
        return resolved({ status: "completed", outcome });
      } else {
        return resolved({ status: "pending" });
      }
    }

    const active = await countActiveFlowWork(
      t,
      request.sessionId,
      request.turnId
    );
    // When the run journaled the effect (R7.1); a queued effect keeps it once dispatched.
    const startedAt = (existing?.startedAt as string | undefined) ?? new Date().toISOString();
    if (!mayDispatchMore(active, await readRuntimeLimits(t))) {
      if (!existing || existing.status !== "queued")
        await t.put("effects", request.effectId, {
          request,
          status: "queued",
          startedAt,
        });
      return resolved({ status: "pending" });
    }

    if (isFlowToolEffect(request)) {
      // A tool stage without `http` would run the developer's code: refused at save, so this
      // is a backstop (HTTP stages are executed by the harness, `harness-api/record.ts`). The
      // stage fails; nothing runs.
      const outcome = {
        value: {
          kind: "failed",
          code: "tool.unavailable",
          message: `The tool stage '${request.key ?? request.path ?? ""}' runs your code, but the Runtime runs agents from their manifests alone`,
        },
      };
      await t.put("effects", request.effectId, {
        request,
        status: "completed",
        outcome,
        startedAt,
        settledAt: startedAt,
      });
      const node = {
        path: request.path!,
        kind: "tool",
        key: request.key!,
        ...(request.iterations !== undefined ? { iterations: request.iterations } : {}),
      };
      await t.event(workflow.id, workflow.activeTurnId, "node.started", node);
      // Nothing ran (R7.1): the stage's outcome row says so.
      await t.event(workflow.id, workflow.activeTurnId, "node.completed", {
        ...node,
        effectId: request.effectId,
        status: "failed",
      });
      return resolved({ status: "completed", outcome });
    }
    return { kind: "agent", workflow, startedAt };
  });
  if (step.kind === "resolved") return step.resolution;

  // agent effect: create linked session + message via the public contract path
  const workflow = step.workflow;
  const body = request.input as {
    agentId: string;
    input: JsonValue;
    /** The flow agent's input, when the stage's input differs from it (D12). */
    flowInput?: JsonValue;
    path: string;
    /** The nested flow agents, outermost first, whose `agents` hold this leaf. */
    flow?: readonly string[];
  };
  const path = body.path ?? request.path!;
  const agentSessionId = deriveAgentEffectSessionId(
    workflow.id,
    path,
    request
  );
  const iterations = request.iterations ?? "-";
  const n = Number(request.context.n ?? iterations.split(".")[0] ?? 1);

  await store.tx(async (t) => {
    await ownedSession(t, lease, workflow.id);
    await t.put("effects", request.effectId, {
      request,
      status: "pending",
      agentSessionId,
      startedAt: step.startedAt,
    });
    await t.put("links", agentSessionId, {
      workflowSessionId: workflow.id,
      path,
      effectId: request.effectId,
      turnId: request.turnId,
    });
  });

  await store.tx(async (t) => {
    // The linked agent (child) session is locked before the workflow (parent).
    const exists = await t.lockSession(agentSessionId);
    await ownedSession(t, lease, workflow.id);
    if (exists) return;
    const definition = leafDefinition(workflow, body, request);
    // The flow's Agent (Q6) reaches every agent in the tree: its sandbox and its vault. Each leaf
    // session runs on it, with the flow's manifest version, and its leaf agent's loop manifest.
    const sandbox = workflow.sandbox;
    const created: Session = {
      id: agentSessionId,
      agentId: workflow.agentId,
      ownerUserId: workflow.ownerUserId,
      manifest: definition.manifest,
      manifestHash: definition.manifestHash,
      ...(workflow.definition === undefined ? {} : { definition: workflow.definition }),
      status: "idle",
      activeTurnId: null,
      creation: {
        requestId: `flow-put-${request.effectId}`,
        agent: workflow.agentId,
        ownerUserId: workflow.ownerUserId,
      },
      flowRootId: workflow.flowRootId ?? workflow.id,
      ...(workflow.environmentId === undefined
        ? {}
        : {
            environmentId: workflow.environmentId,
            ...(workflow.environmentVersion === undefined
              ? {}
              : { environmentVersion: workflow.environmentVersion }),
          }),
      ...(sandbox === undefined ? {} : { sandbox }),
    };
    await t.put("sessions", agentSessionId, created);
  });

  // Binds this effect to the one linked turn its message opens (`linkedTurnEnd`).
  const idempotencyKey = linkedMessageKey(request);
  const messageInput = linkedMessageInput(body);
  const messageCommand: SessionCommand =
    typeof messageInput === "string"
      ? {
          type: "message",
          content: messageInput,
          requestId: `flow-${request.effectId}`,
          idempotencyKey,
        }
      : {
          type: "message",
          data: messageInput,
          requestId: `flow-${request.effectId}`,
          idempotencyKey,
        };
  const accepted = (await command(ctx, agentSessionId, messageCommand, {
    kind: "application",
    principalId: "flow-host",
  })) as { turnId: string | null };

  // Workflow events; the linked agent session is only read here, never locked.
  return store.tx(async (t): Promise<EffectResolution> => {
    const s = await ownedSession(t, lease, request.sessionId);
    const agent = await sessionOf(t, agentSessionId);
    // Only a Loop body's agent turns are iterations: not its verifier, nor a step elsewhere.
    if (typeof request.context.loopPath === "string" && request.context.role !== "verify-agent")
      await t.event(s.id, s.activeTurnId, "loop.iteration", {
        path: request.context.loopPath,
        n,
        sessionId: agentSessionId,
        turnId: accepted.turnId ?? undefined,
        manifestHash: agent.checkpoint?.manifestHash,
      });
    await t.event(s.id, s.activeTurnId, "node.agent", {
      path,
      iterations,
      sessionId: agentSessionId,
      turnId: accepted.turnId,
    });
    // May already be settled if the agent was fast / replayed.
    const outcome = await linkedOutcome(
      t,
      { request, agentSessionId },
      agent
    );
    if (outcome) {
      await settleAgentEffect({
        t,
        effect: { request, status: "pending", agentSessionId } as FlowEffect,
        outcome,
      });
      return { status: "completed", outcome };
    }
    return { status: "pending" };
  });
}

/**
 * The credential of an MCP server or HTTP tool request made on behalf of a session: from its
 * Environment's vault (`vault/sources.ts`).
 */
export async function authorize(
  ctx: TenantContext,
  sessionId: string,
  request: McpCredentialRequest
): Promise<AuthorizeResult> {
  const s = await loadSession(ctx, sessionId);
  return sessionCredentials(ctx.vault, { ...s, id: sessionId }, request);
}

/**
 * The definition a flow leaf's session runs. A flow agent embeds its leaves, so they come
 * from the workflow's own manifest and can't drift from it.
 */
function leafDefinition(
  workflow: Session,
  body: { readonly agentId: string; readonly flow?: readonly string[] },
  request: HostEffect
): {
  manifest: AgentManifest | WorkflowManifest;
  manifestHash: string;
} {
  // A flow agent used as a tool: its manifest is inlined in the parent's pinned tool.
  if (request.context.role === "delegate" && !isWorkflowManifest(workflow.manifest)) {
    const flow = flowDelegateManifest(turnManifestOf(workflow), body.agentId);
    if (!flow) return fail(404, `Agent '${body.agentId}' is not a flow agent used as a tool`);
    return { manifest: flow, manifestHash: hashManifest(flow) };
  }
  const leaf = isWorkflowManifest(workflow.manifest)
    ? embeddedAgent(workflow.manifest, body.flow ?? [], body.agentId)
    : undefined;
  if (!leaf || isWorkflowManifest(leaf))
    return fail(404, `Agent '${body.agentId}' is not embedded in workflow '${workflow.manifest.id}'`);
  const manifest = leaf as AgentManifest;
  return { manifest, manifestHash: hashManifest(manifest) };
}
