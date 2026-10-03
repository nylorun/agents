/**
 * Core's side of effects: `resolveNewFlowEffect` journals and dispatches new workflow effects
 * (linked agent sessions, tool nodes, fn, verify); the takeover helpers say which calls their
 * gate recovers. Also vault authorization for MCP servers. The journal of a run's effects is
 * `harness-api/record.ts`; a harness readies the session's MCP servers itself (`session.mcp`).
 *
 * Every journal write runs in a transaction that locks the effect's session first and checks
 * the advance's ownership epoch (`ownedSession`): after another Worker takes over, the next
 * write throws `ownership.lost` and nothing is written. The model, MCP, sandbox and vault
 * calls run between transactions, never inside one.
 */
import type { Action, ActionOutcome, SessionCommand } from "@nylorun/core/contracts";
import type { EffectResolution, HostEffect } from "@nylorun/harness/run";
import type { AgentManifest, JsonValue, SandboxManifest } from "@nylorun/core/define";
import {
  embeddedAgent,
  flowDelegateManifest,
  hashManifest,
  isWorkflowManifestV2,
  type WorkflowManifestV2,
} from "@nylorun/core/define";
import {
  countActiveFlowWork,
  deriveAgentEffectSessionId,
  isFlowToolEffect,
  isWorkflowManifest,
  linkedMessageKey,
  linkedTurnEnd,
} from "../core/flow-host.js";
import { mayDispatchMore } from "../core/limits.js";
import type { Tx } from "../store/types.js";
import { scrub } from "../redact.js";
import type { AuthorizeResult } from "../vault/service.js";
import { isRemoteMcpCall } from "../harness/calls.js";
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
import { linkedAgentOutput, turnManifestOf } from "./session.js";
import { command } from "./commands.js";
import { offerAction } from "./delivery.js";

/**
 * The outcome of a flow `agent` effect once the linked turn it started ended, or undefined
 * while it has not. The linked session may still show an earlier iteration's turn.
 */
export async function linkedOutcome(
  t: Tx,
  effect: { request: HostEffect; agentSessionId?: string },
  agent: Session | undefined
): Promise<ActionOutcome | undefined> {
  const end = await linkedTurnEnd(t, effect, agent);
  if (!end || !agent) return undefined;
  if (end.status === "completed")
    return { value: linkedAgentOutput(agent, end.output) };
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
 * True when this Tenant's remote MCP calls outlive the process that sent them (the gates
 * service, F4.1 G3): after a takeover or a shutdown, the journaled call is re-sent and joins
 * the running call or gets its answer, instead of becoming `uncertain`.
 */
export function recoversMcpCalls(ctx: TenantContext): boolean {
  return ctx.toolGate.recovers === true;
}

/** True when `request` calls a tool of a remote (`streamable-http` or `sse`) MCP server. */
export function isRemoteMcpEffect(s: Session, request: HostEffect): boolean {
  return isRemoteMcpCall({ rootManifest: s.manifest, mcpSnapshot: s.mcpSnapshot }, request);
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

/** Journal and dispatch a new flow effect (agent / tool node / fn / verify). */
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
        existing.status = "completed";
        existing.outcome = outcome;
        await t.put("effects", request.effectId, existing);
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

    if (
      request.kind === "fn" ||
      request.kind === "verify" ||
      isFlowToolEffect(request)
    ) {
      await t.put("effects", request.effectId, {
        request,
        status: "pending",
      });
      const action =
        request.kind === "fn" || request.kind === "verify"
          ? ({
              actionId: request.effectId,
              sessionId: request.sessionId,
              turnId: request.turnId,
              agentId: request.agentId,
              manifestHash: request.manifestHash,
              implementationVersion: workflow.implementationVersion,
              input: request.input as any,
              context: request.context,
              status: "pending" as const,
              generation: 0,
              kind: request.kind,
              path: request.path!,
              key: request.key!,
            } satisfies Action)
          : ({
              actionId: request.effectId,
              sessionId: request.sessionId,
              turnId: request.turnId,
              agentId: request.agentId,
              manifestHash: request.manifestHash,
              implementationVersion: workflow.implementationVersion,
              input: request.input as any,
              context: request.context,
              status: "pending" as const,
              generation: 0,
              kind: "tool" as const,
              path: request.path!,
              key: request.key!,
            } satisfies Action);
      await t.put("actions", action.actionId, action);
      if (isFlowToolEffect(request)) {
        await t.event(workflow.id, workflow.activeTurnId, "node.started", {
          path: request.path!,
          kind: "tool",
          key: request.key!,
          ...(request.iterations !== undefined
            ? { iterations: request.iterations }
            : {}),
        });
      }
      await t.event(workflow.id, workflow.activeTurnId, "action.pending", {
        actionId: action.actionId,
        kind: action.kind,
        path: action.path,
        key: action.key,
        input: action.input,
      });
      await offerAction(t, ctx, action);
      return resolved({ status: "pending" });
    }
    return { kind: "agent", workflow };
  });
  if (step.kind === "resolved") return step.resolution;

  // agent effect: create linked session + message via the public contract path
  const workflow = step.workflow;
  const body = request.input as {
    agentId: string;
    input: JsonValue;
    path: string;
    /** v2: the nested flow agents, outermost first, whose `agents` hold this leaf. */
    flow?: readonly string[];
    manifest?: AgentManifest;
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
    const definition = await leafDefinition(t, workflow, body, request);
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
      pluginRoots: definition.pluginRoots ?? {},
      ...(sandboxOwnerId ? { sandboxOwnerId } : {}),
      ...(inherited
        ? { sandbox: inherited.spec, sandboxSource: "shared" as const }
        : {}),
    };
    await t.put("sessions", agentSessionId, created);
  });

  // Binds this effect to the one linked turn its message opens (`linkedTurnEnd`).
  const idempotencyKey = linkedMessageKey(request);
  const messageInput = body.input;
  const messageCommand: SessionCommand =
    typeof messageInput === "string"
      ? {
          type: "message",
          content: messageInput,
          requestId: `flow-${request.effectId}`,
          idempotencyKey,
          ...(body.manifest ? { manifest: body.manifest } : {}),
        }
      : {
          type: "message",
          data: messageInput,
          requestId: `flow-${request.effectId}`,
          idempotencyKey,
          ...(body.manifest ? { manifest: body.manifest } : {}),
        };
  const accepted = (await command(ctx, agentSessionId, messageCommand, {
    kind: "application",
    principalId: "flow-host",
  })) as { turnId: string | null };

  // Workflow events; the linked agent session is only read here, never locked.
  return store.tx(async (t): Promise<EffectResolution> => {
    const s = await ownedSession(t, lease, request.sessionId);
    const agent = await sessionOf(t, agentSessionId);
    // Only a Loop's own agent turns are iterations; a step elsewhere in the flow is not.
    if (typeof request.context.loopPath === "string")
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
      await t.put("effects", request.effectId, {
        request,
        status: "completed",
        outcome,
        agentSessionId,
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

/** Vault authorization for an MCP server request made on behalf of a session. */
export async function authorize(
  ctx: TenantContext,
  sessionId: string,
  request: { url: string; serverName?: string }
): Promise<AuthorizeResult> {
  const s = await loadSession(ctx, sessionId);
  const result = await ctx.vault.authorize({
    sessionId,
    vaultIds: s.vaultIds ?? [],
    credentialSelections: s.credentialSelections ?? [],
    url: request.url,
    serverName: request.serverName,
  });
  if (result.status === "authorized") {
    const token = result.headers.authorization.slice("Bearer ".length);
    scrub({ authorization: result.headers.authorization, url: result.url }, [
      token,
    ]);
  }
  return result;
}

/**
 * The definition a flow leaf's session runs. A v2 workflow embeds its leaves, so they
 * come from the workflow's own manifest and can't drift from it; v1 leaves come from the
 * registry by id.
 */
async function leafDefinition(
  t: Tx,
  workflow: Session,
  body: { readonly agentId: string; readonly flow?: readonly string[] },
  request: HostEffect
): Promise<{
  manifest: AgentManifest | WorkflowManifestV2;
  manifestHash: string;
  implementationVersion: string;
  pluginRoots?: Readonly<Record<string, string>>;
}> {
  // A flow agent used as a tool: its manifest is inlined in the parent's pinned tool.
  if (request.context.role === "delegate" && !isWorkflowManifest(workflow.manifest)) {
    const flow = flowDelegateManifest(turnManifestOf(workflow), body.agentId);
    if (!flow) return fail(404, `Agent '${body.agentId}' is not a flow agent used as a tool`);
    return {
      manifest: flow,
      manifestHash: hashManifest(flow),
      implementationVersion: workflow.implementationVersion,
      pluginRoots: leafPluginRoots(workflow.pluginRoots, body.agentId),
    };
  }
  if (isWorkflowManifestV2(workflow.manifest)) {
    const leaf = embeddedAgent(workflow.manifest, body.flow ?? [], body.agentId);
    if (!leaf || isWorkflowManifestV2(leaf as { kind?: unknown; workflowSchemaVersion?: unknown }))
      fail(404, `Agent '${body.agentId}' is not embedded in workflow '${workflow.manifest.id}'`);
    const manifest = leaf as AgentManifest;
    return {
      manifest,
      manifestHash: hashManifest(manifest),
      implementationVersion: workflow.implementationVersion,
      pluginRoots: leafPluginRoots(workflow.pluginRoots, body.agentId),
    };
  }
  const definition = await t.get("definitions", body.agentId);
  if (!definition) fail(404, "Definition not found");
  return definition as {
    manifest: AgentManifest;
    manifestHash: string;
    implementationVersion: string;
    pluginRoots?: Readonly<Record<string, string>>;
  };
}

/**
 * A v2 workflow keys its leaves' plugin roots `<agentId>/<capability>`, and an agent keys
 * a flow agent it uses as a tool the same way (`<flowId>/<leafId>/<capability>`).
 */
function leafPluginRoots(
  roots: Readonly<Record<string, string>> | undefined,
  agentId: string
): Record<string, string> {
  const own: Record<string, string> = {};
  const prefix = `${agentId}/`;
  for (const [key, root] of Object.entries(roots ?? {}))
    if (key.startsWith(prefix)) own[key.slice(prefix.length)] = root;
  return own;
}
