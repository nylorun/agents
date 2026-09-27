/**
 * The engine host: `resolveEffect` journals each effect before it is invoked and dispatches it
 * to the model service, the MCP pool, the SandboxManager, or an Action for the executor.
 * `resolveNewFlowEffect` does the same for workflow effects (linked agent sessions, tool
 * nodes, fn, verify). Also MCP preparation and vault authorization for MCP servers.
 *
 * Every journal write runs in a transaction that locks the effect's session first. The
 * model, MCP, sandbox and vault calls run between transactions, never inside one.
 *
 * `invokeModel` lives here rather than in `advance.ts`: it is one of the effect dispatchers,
 * and keeping it here avoids an import cycle between the advance and the engine host.
 *
 * Later waves: Wave 2 / X adds the epoch check to each write.
 */
import type { Action, SessionCommand } from "@nylorun/core/contracts";
import type { EffectResolution, HostEffect } from "@nylorun/harness/run";
import type { AgentManifest, JsonValue } from "@nylorun/core/define";
import {
  countActiveFlowWork,
  deriveAgentEffectSessionId,
  isFlowEffect,
  isFlowToolEffect,
} from "../core/flow-host.js";
import { mayDispatchMore } from "../core/limits.js";
import { canonical } from "../store/canonical.js";
import { piModel } from "../model/pi-model.js";
import { scrub } from "../redact.js";
import type { AuthorizeResult } from "../vault/service.js";
import { serversOf } from "../mcp/pool.js";
import { sandboxCapabilityOf } from "../sandbox/manager.js";
import { owningSandboxSessionId, sandboxSpecOf } from "../sandbox/share.js";
import {
  loadSession,
  lockedSession,
  sandboxLookup,
  sessionOf,
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
} from "./session.js";
import { command } from "./commands.js";

export function invokeModel(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal
) {
  if (!ctx.useVaultModel) return ctx.modelProvider(request, signal);
  const adapter = piModel({
    root: ctx.config.paths.home,
    readHostModel: () => ctx.vault.readHostModel(),
    writeHostCredential: (credential) =>
      ctx.vault.updateHostCredential(credential),
  });
  return adapter(request.input as any, {
    request: request.context.request as any,
    invocationId: String(request.context.invocationId),
    signal,
    reportPreparedCall() {},
  });
}

type Journaled =
  | { kind: "resolved"; resolution: EffectResolution }
  | { kind: "flow" }
  | { kind: "invoke"; invoke: "model" | "mcp" | "sandbox" };

export async function resolveEffect(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal
): Promise<EffectResolution> {
  const { store } = ctx;
  const journaled = await store.tx(async (t): Promise<Journaled> => {
    const s = await lockedSession(t, request.sessionId);
    if (
      s.status === "cancelled" ||
      s.activeTurnId !== request.turnId ||
      signal.aborted
    )
      throw new Error("Turn cancelled");
    const resolved = (resolution: EffectResolution): Journaled => ({
      kind: "resolved",
      resolution,
    });
    const existing = await t.get("effects", request.effectId);
    if (existing) {
      if (canonical(existing.request) !== canonical(request))
        throw new Error("Effect identity request drift");
      if (existing.status === "completed")
        return resolved({ status: "completed", outcome: existing.outcome });
      if (request.kind === "agent" && existing.status === "pending") {
        const agentSessionId = existing.agentSessionId as string | undefined;
        if (agentSessionId) {
          const agent = await t.get<Session>("sessions", agentSessionId);
          if (agent?.status === "completed") {
            const outcome = {
              value: linkedAgentOutput(agent, agent.lastOutput ?? null),
            };
            existing.status = "completed";
            existing.outcome = outcome;
            await t.put("effects", request.effectId, existing);
            return resolved({ status: "completed", outcome });
          }
          if (agent?.status === "failed") {
            const outcome = {
              value: {
                kind: "failed",
                code: "agent.failed",
                message: agent.error ?? "Agent turn failed",
              },
            };
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
        { agent: request.agent, ...(request.input as object) }
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
      claimId: null,
      leaseExpiresAt: null,
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
      input: action.input,
    });
    t.signalWork();
    return resolved({ status: "pending" });
  });
  if (journaled.kind === "resolved") return journaled.resolution;
  if (journaled.kind === "flow") {
    if (isFlowEffect(request))
      return resolveNewFlowEffect(ctx, request, signal);
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
        : await invokeModel(ctx, request, signal);
    return await store.tx(async (t) => {
      const s = await lockedSession(t, request.sessionId);
      if (
        s.status === "cancelled" ||
        s.activeTurnId !== request.turnId ||
        signal.aborted
      )
        throw new Error("Turn cancelled");
      const effect = await t.get("effects", request.effectId);
      effect.status = "completed";
      effect.outcome = { value };
      await t.put("effects", request.effectId, effect);
      return { status: "completed" as const, outcome: effect.outcome };
    });
  } catch (error) {
    await store.tx(async (t) => {
      const s = await t.lockSession<Session>(request.sessionId);
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
  signal: AbortSignal
): Promise<EffectResolution> {
  const { store } = ctx;
  if (signal.aborted) throw new Error("Turn cancelled");
  const step = await store.tx(async (t): Promise<FlowStep> => {
    const resolved = (resolution: EffectResolution): FlowStep => ({
      kind: "resolved",
      resolution,
    });
    const workflow = await lockedSession(t, request.sessionId);
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
        const settled = (value: unknown) => ({ value }) as { value: any };
        const outcome =
          agent?.status === "completed"
            ? settled(linkedAgentOutput(agent, agent.lastOutput ?? null))
            : agent?.status === "cancelled"
            ? settled({
                kind: "failed" as const,
                code: "agent.cancelled",
                message: agent.error ?? "Agent turn was cancelled",
              })
            : agent?.status === "failed"
            ? settled({
                kind: "failed" as const,
                code: "agent.failed",
                message: agent.error ?? "Agent turn failed",
              })
            : undefined;
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
              claimId: null,
              leaseExpiresAt: null,
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
              claimId: null,
              leaseExpiresAt: null,
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
      t.signalWork();
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
    await t.lockSession(workflow.id);
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
    if (await t.lockSession(agentSessionId)) return;
    const definition =
      (await t.get("definitions", body.agentId)) ??
      fail(404, "Definition not found");
    const sandboxOwnerId =
      sandboxSpecOf(workflow.manifest) || workflow.sandboxOwnerId
        ? owningSandboxSessionId(
            workflow,
            await sandboxLookup(t, workflow.sandboxOwnerId)
          )
        : undefined;
    const created: Session = {
      id: agentSessionId,
      agentId: body.agentId,
      ownerUserId: workflow.ownerUserId,
      manifest: definition.manifest,
      manifestHash: definition.manifestHash,
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
    };
    await t.put("sessions", agentSessionId, created);
  });

  const idempotencyKey = `${request.turnId}:${path}:${iterations}`;
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
    const s = await lockedSession(t, request.sessionId);
    const agent = await sessionOf(t, agentSessionId);
    await t.event(s.id, s.activeTurnId, "loop.iteration", {
      path: String(request.context.loopPath ?? path.split("/")[0]),
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
    if (agent.status === "completed") {
      const outcome = {
        value: linkedAgentOutput(agent, agent.lastOutput ?? null),
      };
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
  id: string,
  signal: AbortSignal
): Promise<void> {
  const { store } = ctx;
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
      const current = await lockedSession(t, id);
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
    const current = await lockedSession(t, id);
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
