/**
 * The engine host: `resolveEffect` journals each effect before it is invoked and dispatches it
 * to the model service, the MCP pool, the SandboxManager, or an Action for the agent's endpoint.
 * `resolveNewFlowEffect` does the same for workflow effects (linked agent sessions, tool
 * nodes, fn, verify). Also MCP preparation and vault authorization for MCP servers.
 *
 * Every journal write runs in a transaction that locks the effect's session first and checks
 * the advance's ownership epoch (`ownedSession`): after another Worker takes over, the next
 * write throws `ownership.lost` and nothing is written. The model, MCP, sandbox and vault
 * calls run between transactions, never inside one.
 *
 * `invokeModel` lives here rather than in `advance.ts`: it is one of the effect dispatchers,
 * and keeping it here avoids an import cycle between the advance and the engine host.
 */
import type {
  Action,
  ActionOutcome,
  SessionCommand,
} from "@nylorun/core/contracts";
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
  isFlowEffect,
  isFlowToolEffect,
  isWorkflowManifest,
  linkedMessageKey,
  linkedTurnEnd,
} from "../core/flow-host.js";
import { mayDispatchMore } from "../core/limits.js";
import { canonical } from "../store/canonical.js";
import type { Tx } from "../store/types.js";
import { isOwnershipLost } from "../store/ownership.js";
import { newStreamIncarnation } from "../streams/types.js";
import { piModel } from "../model/pi-model.js";
import { scrub } from "../redact.js";
import type { AuthorizeResult } from "../vault/service.js";
import { serversOf } from "../mcp/pool.js";
import { sandboxCapabilityOf } from "../sandbox/manager.js";
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
import {
  actionTarget,
  linkedAgentOutput,
  manifestFor,
  mcpToolOf,
  pinnedTool,
  turnManifestOf,
} from "./session.js";
import { command } from "./commands.js";
import { offerAction } from "./delivery.js";
import {
  assistantMessage,
  contextCompacted,
  modelFailed,
  toolCompleted,
  toolIds,
} from "./transcript.js";
import { classifyThrown } from "../model/classify.js";
import { abortKind } from "./worker.js";
import type { ModelProvider } from "../core/provider.js";

/** What one advance's segment decides for all its effects. */
export interface SegmentOptions {
  /** Overrides the Tenant's model (the fixture-model Tenant setting, `model-setting.ts`). */
  model?: ModelProvider;
}

/**
 * Call the model for one effect. A provider failure comes back as a failure outcome
 * (Model Calls §6), whichever provider serves the call; only an abort throws, and the
 * advance decides what the abort means.
 */
export async function invokeModel(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal,
  model?: ModelProvider
): Promise<unknown> {
  try {
    if (model) return await model(request, signal);
    if (!ctx.useVaultModel) return await ctx.modelProvider(request, signal);
    const adapter = piModel({
      root: ctx.config.paths.home,
      readHostModel: () => ctx.vault.readHostModel(),
      writeHostCredential: (credential) =>
        ctx.vault.updateHostCredential(credential),
      ...(ctx.config.modelCall ? { settings: ctx.config.modelCall } : {}),
    });
    return await adapter(request.input as any, {
      request: request.context.request as any,
      invocationId: String(request.context.invocationId),
      signal,
      reportPreparedCall() {},
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return classifyThrown(error);
  }
}

/**
 * The outcome of a flow `agent` effect once the linked turn it started ended, or undefined
 * while it has not. The linked session may still show an earlier iteration's turn.
 */
async function linkedOutcome(
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

type Journaled =
  | { kind: "resolved"; resolution: EffectResolution }
  | { kind: "flow" }
  | { kind: "invoke"; invoke: "model" | "mcp" | "sandbox" };

/**
 * What an effect's journal row must match on replay. A delegation's context carries only the
 * parent's tool call id, for its events; rows journaled before it existed still match.
 */
function requestIdentity(request: HostEffect): HostEffect {
  if (request.kind !== "delegation") return request;
  const { context: _, ...identity } = request;
  return identity as HostEffect;
}

function delegationCallId(request: HostEffect): { callId?: string } {
  const callId = (request.context as { callId?: unknown } | undefined)?.callId;
  return typeof callId === "string" ? { callId } : {};
}

export async function resolveEffect(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal,
  lease: Lease,
  segment: SegmentOptions = {}
): Promise<EffectResolution> {
  const { store } = ctx;
  const journaled = await store.tx(async (t): Promise<Journaled> => {
    const s = await ownedSession(t, lease, request.sessionId);
    if (s.status === "cancelled" || s.activeTurnId !== request.turnId)
      throw new Error("Turn cancelled");
    // An aborted advance starts no effect; the advance decides what the abort means.
    signal.throwIfAborted();
    const resolved = (resolution: EffectResolution): Journaled => ({
      kind: "resolved",
      resolution,
    });
    const existing = await t.get("effects", request.effectId);
    if (existing) {
      if (canonical(requestIdentity(existing.request)) !== canonical(requestIdentity(request)))
        throw new Error("Effect identity request drift");
      if (existing.status === "completed")
        return resolved({ status: "completed", outcome: existing.outcome });
      if (request.kind === "agent" && existing.status === "pending") {
        const agentSessionId = existing.agentSessionId as string | undefined;
        if (agentSessionId) {
          const agent = await t.get<Session>("sessions", agentSessionId);
          const outcome = await linkedOutcome(t, existing, agent);
          if (outcome) {
            existing.status = "completed";
            existing.outcome = outcome;
            await t.put("effects", request.effectId, existing);
            return resolved({ status: "completed", outcome });
          }
        }
      }
      return resolved({
        status:
          existing.status === "uncertain" || existing.status === "invoking"
            ? "uncertain"
            : "pending",
      });
    }
    if (
      request.kind === "agent" ||
      request.kind === "fn" ||
      request.kind === "verify" ||
      isFlowToolEffect(request)
    ) {
      // Handled outside the agent-manifest path below.
      return { kind: "flow" };
    }
    if (request.kind === "delegation") {
      // Lifecycle points of an agent used as a tool: journaled once, so replays never re-emit.
      const outcome = { value: null };
      await t.put("effects", request.effectId, {
        request,
        status: "completed",
        outcome,
      });
      const settled = request.effectId.endsWith(":settled");
      await t.event(
        s.id,
        s.activeTurnId,
        settled ? "delegation.completed" : "delegation.started",
        {
          agent: request.agent,
          ...delegationCallId(request),
          ...(request.input as object),
        }
      );
      return resolved({ status: "completed", outcome });
    }
    const agentManifest = manifestFor(s.manifest, request.agent);
    if (!agentManifest)
      throw new Error(
        `Agent '${request.agent?.id ?? ""}' is not used as a tool`
      );
    const mcpTool = request.kind === "tool" ? mcpToolOf(s, request) : undefined;
    const sandboxTool =
      request.kind === "tool" && !mcpTool
        ? sandboxCapabilityOf(
            agentManifest,
            request.capabilityId,
            request.toolName
          )
        : undefined;
    await t.put("effects", request.effectId, {
      request,
      status:
        request.kind === "model" || mcpTool || sandboxTool
          ? "invoking"
          : "pending",
    });
    if (request.kind === "model" || mcpTool || sandboxTool)
      return {
        kind: "invoke",
        invoke: mcpTool ? "mcp" : sandboxTool ? "sandbox" : "model",
      };
    const tool =
      request.kind === "tool"
        ? pinnedTool(agentManifest, request.capabilityId, request.toolName)
        : undefined;
    const base = {
      actionId: request.effectId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      agentId: request.agentId,
      manifestHash: request.manifestHash,
      implementationVersion: s.implementationVersion,
      input: request.input,
      context: request.context,
      status: "pending" as const,
      generation: 0,
      ...(request.agent ? { agent: request.agent } : {}),
    };
    const action: Action =
      request.kind === "hook"
        ? {
            ...base,
            kind: "hook",
            hook: {
              at: request.hook!.at,
              scope: request.hook!.scope,
              capabilityIds: [...request.hook!.capabilityIds],
            },
          }
        : {
            ...base,
            kind: "tool",
            capabilityId: request.capabilityId!,
            toolName: request.toolName!,
            ...(tool?.inputSchema ? { inputSchema: tool.inputSchema } : {}),
            ...(tool?.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          };
    await t.put("actions", action.actionId, action);
    await t.event(s.id, s.activeTurnId, "action.pending", {
      actionId: action.actionId,
      kind: action.kind,
      ...actionTarget(action),
      ...(action.kind === "tool" ? toolIds(request.context) : {}),
      input: action.input,
    });
    await offerAction(t, ctx, action);
    return resolved({ status: "pending" });
  });
  if (journaled.kind === "resolved") return journaled.resolution;
  if (journaled.kind === "flow") {
    if (isFlowEffect(request))
      return resolveNewFlowEffect(ctx, request, signal, lease);
    return { status: "pending" };
  }
  const invoke = journaled.invoke;
  try {
    // The intent is committed; the call itself runs outside any transaction.
    const value =
      invoke === "mcp"
        ? await callMcpTool(ctx, request)
        : invoke === "sandbox"
        ? await callSandboxTool(ctx, request, signal)
        : await invokeModel(ctx, request, signal, segment.model);
    return await store.tx(async (t) => {
      const s = await ownedSession(t, lease, request.sessionId);
      // Only a cancel discards an outcome in hand (§10.7). After any other abort (shutdown,
      // deadline) it is recorded, so the next advance replays it instead of calling again.
      if (
        s.status === "cancelled" ||
        s.activeTurnId !== request.turnId ||
        abortKind(signal) === "cancel"
      )
        throw new Error("Turn cancelled");
      const effect = await t.get("effects", request.effectId);
      effect.status = "completed";
      effect.outcome = { value };
      await t.put("effects", request.effectId, effect);
      const failed = invoke === "model" ? modelFailed(request, value) : undefined;
      // A summary call is never an assistant message; the last one publishes context.compacted.
      const summarizing =
        invoke === "model" && Boolean((request.context as { compaction?: unknown }).compaction);
      const compacted =
        summarizing && !failed ? contextCompacted(request, value) : undefined;
      const transcript =
        failed || summarizing
          ? undefined
          : invoke === "model"
          ? assistantMessage(request, value)
          : toolCompleted(request, value);
      if (failed) await t.event(s.id, request.turnId, "model.failed", failed);
      if (compacted)
        await t.event(s.id, request.turnId, "context.compacted", compacted);
      if (transcript)
        await t.event(
          s.id,
          request.turnId,
          invoke === "model" ? "message.assistant" : "tool.completed",
          transcript
        );
      return { status: "completed" as const, outcome: effect.outcome };
    });
  } catch (error) {
    // A lost epoch writes nothing: the new owner decides what the effect became.
    if (isOwnershipLost(error)) throw error;
    await store.tx(async (t) => {
      const s =
        request.sessionId === lease.sessionId
          ? await t.assertEpoch<Session>(request.sessionId, lease.epoch)
          : await t.lockSession<Session>(request.sessionId);
      const effect = await t.get("effects", request.effectId);
      if (!effect) return;
      effect.status = "uncertain";
      effect.error = error instanceof Error ? error.message : String(error);
      await t.put("effects", request.effectId, effect);
      if (s && s.status !== "cancelled" && s.activeTurnId === request.turnId)
        await t.event(s.id, request.turnId, "effect.uncertain", {
          effectId: request.effectId,
          message: effect.error,
        });
    });
    return { status: "uncertain" };
  }
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

  const backend = (await ctx.sandbox.ready).backend?.name;
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
      definition,
      backend
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
      streamIncarnation: newStreamIncarnation(),
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

/** Discover the session's MCP tools once, or reconnect and refresh diagnostics. */
export async function prepareMcp(
  ctx: TenantContext,
  lease: Lease,
  signal: AbortSignal
): Promise<void> {
  const { store } = ctx;
  const id = lease.sessionId;
  const s = await loadSession(ctx, id);
  if (serversOf(s.manifest).length === 0) return;
  if (!s.mcpSnapshot) {
    const found = await ctx.mcp.discover({
      sessionId: id,
      manifest: s.manifest,
      manifestHash: s.manifestHash,
      pluginRoots: s.pluginRoots ?? {},
      signal,
    });
    await store.tx(async (t) => {
      const current = await ownedSession(t, lease, id);
      if (current.mcpSnapshot) return;
      current.mcpSnapshot = found.snapshot;
      current.mcpDiagnostics = found.diagnostics;
      await t.put("sessions", id, current);
    });
    return;
  }
  const diagnostics = await ctx.mcp.reconnect({
    sessionId: id,
    manifest: s.manifest,
    pluginRoots: s.pluginRoots ?? {},
    tools: s.mcpSnapshot.mcpTools,
    signal,
  });
  if (diagnostics.length === 0) return;
  await store.tx(async (t) => {
    const current = await ownedSession(t, lease, id);
    const prior = [...(current.mcpDiagnostics ?? [])];
    for (const item of diagnostics) {
      const index = prior.findIndex(
        (existing) =>
          existing.capabilityId === item.capabilityId &&
          existing.serverName === item.serverName
      );
      if (index >= 0) prior[index] = item;
      else prior.push(item);
    }
    current.mcpDiagnostics = prior;
    await t.put("sessions", id, current);
  });
}

async function callMcpTool(
  ctx: TenantContext,
  request: HostEffect
): Promise<unknown> {
  const s = await loadSession(ctx, request.sessionId);
  const tool = mcpToolOf(s, request);
  if (!tool)
    throw new Error(
      `MCP tool '${request.toolName ?? ""}' is not in the session snapshot`
    );
  return ctx.mcp.call({
    sessionId: s.id,
    ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
    capabilityId: tool.capabilityId,
    serverName: tool.serverName,
    serverToolName: tool.serverToolName,
    args: request.input,
    manifest: s.manifest,
    pluginRoots: s.pluginRoots ?? {},
  });
}

/**
 * The sandbox a linked session inherits from its tree's owner when that sandbox was chosen at
 * open (pinned on the owner). A definition that declares its own sandbox keeps it, as before.
 */
function inheritedSandbox(
  owner: Session | undefined,
  definition: { manifest: any; manifestHash: string },
  backend: string | undefined
):
  | { spec: SandboxManifest; manifest?: AgentManifest; manifestHash?: string }
  | undefined {
  const spec = owner?.sandbox;
  if (!spec || sandboxSpecOf(definition.manifest)) return undefined;
  if (isWorkflowManifest(definition.manifest)) return { spec };
  const sandboxed = withSandboxCapability(definition.manifest as AgentManifest, spec, backend);
  if (!sandboxed.ok) throw new Error(sandboxed.message);
  return { spec, manifest: sandboxed.manifest, manifestHash: sandboxed.manifestHash };
}

async function callSandboxTool(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal
): Promise<unknown> {
  const { s, ownerId } = await ctx.store.tx(async (t) => {
    const s = await sessionOf(t, request.sessionId);
    // Agents used as tools share the session's sandbox; the tree declares one sandbox spec.
    const lookup = await sandboxLookup(t, s.id);
    return { s, ownerId: owningSandboxSessionId(s, lookup) };
  });
  const capability = sandboxCapabilityOf(
    manifestFor(s.manifest, request.agent),
    request.capabilityId,
    request.toolName
  );
  if (!capability)
    throw new Error(`'${request.toolName ?? ""}' is not a sandbox tool`);
  return ctx.sandbox.run(
    { id: ownerId, activeTurnId: s.activeTurnId, manifest: s.manifest },
    capability,
    request.toolName as never,
    request.input,
    signal
  );
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
