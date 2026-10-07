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
import type { Tx } from "../store/types.js";
import type { AuthorizeResult } from "../vault/service.js";
import { sessionCredentials, type McpCredentialRequest } from "../vault/sources.js";
import { isRemoteMcpCall } from "../harness/calls.js";
import { isHttpToolCall } from "../gates/http-tool.js";
import {
  owningSandboxSessionId,
  sandboxSpecOf,
  sessionSandboxSpec,
} from "../sandbox/share.js";
import { withSandboxCapability } from "../sandbox/session-sandbox.js";
import {
  loadSession,
  ownedSession,
  sandboxLookup,
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
    isRemoteMcpCall({ rootManifest: s.manifest, mcpSnapshot: s.mcpSnapshot }, request) ||
    isHttpToolCall(s.manifest, request)
  );
}

/**
 * True when this Tenant's vault-backed model calls outlive the process that sent them (the
 * gates service, P1.2): after a takeover or a shutdown, the journaled call is re-sent and joins
 * the running call or gets its outcome, instead of becoming `uncertain`.
 */
export function recoversModelCalls(ctx: TenantContext): boolean {
  return ctx.useVaultModel && ctx.modelGate.recovers === true;
}

type FlowStep =
  | { kind: "resolved"; resolution: EffectResolution }
  | { kind: "agent"; workflow: Session };

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
    if (!mayDispatchMore(active, ctx.flowLimits)) {
      if (!existing || existing.status !== "queued")
        await t.put("effects", request.effectId, {
          request,
          status: "queued",
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
          message: `The tool stage '${request.key ?? request.path ?? ""}' runs your code, and the Runtime runs no code of yours during a session`,
        },
      };
      await t.put("effects", request.effectId, { request, status: "completed", outcome });
      await t.event(workflow.id, workflow.activeTurnId, "node.started", {
        path: request.path!,
        kind: "tool",
        key: request.key!,
        ...(request.iterations !== undefined ? { iterations: request.iterations } : {}),
      });
      return resolved({ status: "completed", outcome });
    }
    return { kind: "agent", workflow };
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
    const lookup = await sandboxLookup(t, workflow.sandboxOwnerId);
    const sandboxOwnerId =
      sessionSandboxSpec(workflow) || workflow.sandboxOwnerId
        ? owningSandboxSessionId(workflow, lookup)
        : undefined;
    // A sandbox chosen when the tree was opened reaches every agent in it, with its tools.
    const inherited = inheritedSandbox(
      sandboxOwnerId === undefined ? undefined : lookup(sandboxOwnerId) ?? workflow,
      definition
    );
    const created: Session = {
      id: agentSessionId,
      agentId: body.agentId,
      ownerUserId: workflow.ownerUserId,
      manifest: inherited?.manifest ?? definition.manifest,
      manifestHash: inherited?.manifestHash ?? definition.manifestHash,
      implementationVersion: definition.implementationVersion,
      status: "idle",
      activeTurnId: null,
      creation: {
        requestId: `flow-put-${request.effectId}`,
        agentId: body.agentId,
        ownerUserId: workflow.ownerUserId,
        ...(sandboxOwnerId ? { sandbox: { session: sandboxOwnerId } } : {}),
      },
      vaultIds: workflow.vaultIds,
      credentialSelections: workflow.credentialSelections,
      ...(sandboxOwnerId ? { sandboxOwnerId } : {}),
      ...(inherited
        ? { sandbox: inherited.spec, sandboxSource: "shared" as const }
        : {}),
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
 * The sandbox a linked session inherits from its tree's owner when that sandbox was chosen at
 * open (pinned on the owner). A definition that declares its own sandbox keeps it, as before.
 */
function inheritedSandbox(
  owner: Session | undefined,
  definition: { manifest: any; manifestHash: string }
):
  | { spec: SandboxManifest; manifest?: AgentManifest; manifestHash?: string }
  | undefined {
  const spec = owner?.sandbox;
  if (!spec || sandboxSpecOf(definition.manifest)) return undefined;
  if (isWorkflowManifest(definition.manifest)) return { spec };
  const sandboxed = withSandboxCapability(definition.manifest as AgentManifest, spec);
  if (!sandboxed.ok) throw new Error(sandboxed.message);
  return { spec, manifest: sandboxed.manifest, manifestHash: sandboxed.manifestHash };
}

/**
 * The credential of an MCP server or HTTP tool request made on behalf of a session: from its
 * attached vaults (`vault/sources.ts`).
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
  implementationVersion: string;
} {
  // A flow agent used as a tool: its manifest is inlined in the parent's pinned tool.
  if (request.context.role === "delegate" && !isWorkflowManifest(workflow.manifest)) {
    const flow = flowDelegateManifest(turnManifestOf(workflow), body.agentId);
    if (!flow) return fail(404, `Agent '${body.agentId}' is not a flow agent used as a tool`);
    return {
      manifest: flow,
      manifestHash: hashManifest(flow),
      implementationVersion: workflow.implementationVersion,
    };
  }
  const leaf = isWorkflowManifest(workflow.manifest)
    ? embeddedAgent(workflow.manifest, body.flow ?? [], body.agentId)
    : undefined;
  if (!leaf || isWorkflowManifest(leaf))
    return fail(404, `Agent '${body.agentId}' is not embedded in workflow '${workflow.manifest.id}'`);
  const manifest = leaf as AgentManifest;
  return {
    manifest,
    manifestHash: hashManifest(manifest),
    implementationVersion: workflow.implementationVersion,
  };
}
