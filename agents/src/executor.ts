import {
  AgentManifestSchema,
  ActionSchema,
  ActionClaimResponseSchema,
  type Action,
} from "@nylorun/core/contracts";
import {
  agentFrom,
  delegateOf,
  hashManifest,
  isFlowDelegate,
  isBuiltWorkflow,
  type BuiltAgent,
  type BuiltWorkflow,
} from "@nylorun/core/define";
import {
  AgentsClient,
  assertNoMiddlewareClosures,
  type AgentSource,
} from "./client.js";
import { resolveConnection } from "./connection.js";
import { deriveExecutorToken } from "./derived-credentials.js";
import {
  Transport,
  RuntimeError,
  delay,
  env,
  id,
  segment,
  type Destination,
} from "./http.js";
import { readSSE } from "./sse.js";
import { executeAction, type ExecutableDefinition } from "./execute-action.js";
import {
  createActionSandbox,
  definitionDeclaresSandbox,
} from "./sandbox/client.js";

export interface ConnectOptions {
  agents: readonly (AgentSource | BuiltWorkflow)[];
  /** Application-mode client; when set, connectAgents uses application mode (D§7.2). */
  application?: AgentsClient;
  runtime?: Destination;
  implementationVersion?: string;
  onError?: (error: unknown) => void;
}
export interface AgentConnection {
  /** Settles after authenticated SSE is established and initial discovery succeeds. */
  readonly ready: Promise<void>;
  /** Abort subscriptions and leases. Running user code receives an AbortSignal. */
  close(): Promise<void>;
}

function implementationVersionOf(options: ConnectOptions): string {
  return (
    options.implementationVersion ??
    env("NYLORUN_IMPLEMENTATION_VERSION") ??
    "dev"
  );
}

/** Agents embedded in a v2 workflow: served here, but saved only as part of the workflow. */
const embeddedAgents = new WeakMap<Map<string, ExecutableDefinition>, Set<string>>();

function buildAgents(options: ConnectOptions): Map<string, ExecutableDefinition> {
  const agents = new Map<string, ExecutableDefinition>();
  const embedded = new Set<string>();
  /**
   * Agents embedded in another definition (a v2 flow's agents, a flow agent used as a
   * tool) may be reached from more than one place; the same definition is served once.
   */
  const sameAsServed = (id: string, manifest: object): boolean => {
    const served = agents.get(id);
    if (!served) return false;
    if (hashManifest(served.manifest as never) === hashManifest(manifest as never)) return true;
    throw new Error(`Duplicate connected agent ${id}`);
  };
  const addAgent = (built: BuiltAgent, shared = false) => {
    assertNoMiddlewareClosures(built);
    AgentManifestSchema.parse(built.manifest);
    if (shared ? sameAsServed(built.id, built.manifest) : agents.has(built.id)) {
      if (!shared) throw new Error(`Duplicate connected agent ${built.id}`);
      return;
    }
    agents.set(built.id, built);
    for (const tool of built.getBinding().tools) {
      const delegate = delegateOf(tool);
      if (!delegate || !isFlowDelegate(delegate)) continue;
      // A flow agent used as a tool runs in its own linked session: serve its code too.
      if (!delegate.workflow)
        throw new Error(
          `Flow agent '${delegate.manifest.id}' is used as a tool by '${built.id}' but has no local implementation`,
        );
      addWorkflow(delegate.workflow, true);
      embedded.add(delegate.workflow.id);
    }
  };
  const addWorkflow = (workflow: BuiltWorkflow, shared = false) => {
    if (shared ? sameAsServed(workflow.id, workflow.manifest) : agents.has(workflow.id)) {
      if (!shared) throw new Error(`Duplicate connected agent ${workflow.id}`);
      return;
    }
    agents.set(workflow.id, workflow);
    const v2 = workflow.manifest.workflowSchemaVersion === 2;
    for (const binding of Object.values(workflow.getBinding().agents)) {
      addAgent(agentFrom(binding.manifest, binding.implementations), v2);
      if (v2) embedded.add(binding.manifest.id);
    }
  };
  for (const source of options.agents) {
    if (isBuiltWorkflow(source)) {
      addWorkflow(source);
      continue;
    }
    const built = source.build?.() ?? (source as BuiltAgent);
    if (isBuiltWorkflow(built)) {
      addWorkflow(built);
      continue;
    }
    addAgent(built);
  }
  if (!agents.size) throw new Error("connectAgents requires at least one agent");
  // A definition passed in directly is saved on its own, even if another one embeds it.
  for (const source of options.agents) embedded.delete(source.id);
  embeddedAgents.set(agents, embedded);
  return agents;
}

/**
 * The manifest hash an executor serves for a workflow's flow actions. A run is pinned to
 * one workflow manifest, and its stage keys may shift between deploys, so flow actions
 * for another hash are left for the executor that serves it.
 */
function flowManifestHash(agent: ExecutableDefinition): string | undefined {
  return isBuiltWorkflow(agent) && agent.manifest.workflowSchemaVersion === 2
    ? hashManifest(agent.manifest)
    : undefined;
}

function connectExecutorMode(
  options: ConnectOptions,
  runtime: Destination,
  agents: Map<string, ExecutableDefinition>,
): AgentConnection {
  const transport = new Transport(runtime, "executor");
  const version = implementationVersionOf(options);
  const controller = new AbortController();
  const signal = controller.signal;
  const active = new Map<string, AbortController>();
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Avoid an unhandled rejection for callers that immediately close the handle.
  void ready.catch(() => {});
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {}
  };
  const skipped = new Set<string>();
  let discovering = false,
    dirty = false;
  const discover = async () => {
    dirty = true;
    if (discovering) return;
    discovering = true;
    try {
      while (dirty && !signal.aborted) {
        dirty = false;
        const response = await transport.json<{ actions: unknown[] }>(
          "/v1/actions",
          "GET",
          undefined,
          signal,
        );
        for (const item of response.actions) {
          // Skip actions this SDK cannot run (e.g. from an older Runtime) instead of stalling discovery.
          const parsed = ActionSchema.safeParse(item);
          if (!parsed.success) {
            report(parsed.error);
            continue;
          }
          const action = parsed.data;
          const agent = agents.get(action.agentId);
          if (!agent || action.status !== "pending" || active.has(action.actionId))
            continue;
          const served = flowManifestHash(agent);
          if (served !== undefined && "key" in action && action.manifestHash !== served) {
            if (!skipped.has(action.actionId)) {
              skipped.add(action.actionId);
              report(
                new Error(
                  `Skipped action ${action.actionId}: it belongs to manifest ${action.manifestHash} of '${action.agentId}', and this executor serves ${served}`,
                ),
              );
            }
            continue;
          }
          const work = new AbortController();
          active.set(action.actionId, work);
          let delivered = false;
          void processAction(action, agent, work)
            .then(() => {
              delivered = true;
            })
            .catch((error) => {
              if (!signal.aborted) report(error);
            })
            .finally(() => {
              active.delete(action.actionId);
              // Completion-driven discovery drains bounded server pages without periodic polling.
              if (delivered && !signal.aborted) void discover().catch(report);
            });
        }
      }
    } finally {
      discovering = false;
    }
  };
  const processAction = async (
    action: Action,
    agent: ExecutableDefinition,
    work: AbortController,
  ) => {
    const stop = () => work.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    let renewal: Promise<void> | undefined;
    let renewing = true;
    let wakeRenewal: (() => void) | undefined;
    try {
      const claim = ActionClaimResponseSchema.parse(
        await transport.json(
          `/v1/actions/${segment(action.actionId)}/claim`,
          "POST",
          {
            requestId: id(),
            implementationVersion: version,
          },
          work.signal,
        ),
      );
      if (claim.action.actionId !== action.actionId)
        throw new Error("Claim definition mismatch");
      let expires = Date.parse(claim.leaseExpiresAt);
      renewal = (async () => {
        while (renewing && !work.signal.aborted) {
          const remaining = expires - Date.now();
          if (!Number.isFinite(remaining) || remaining <= 0)
            throw new Error("Executor lease expired");
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              work.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(
              finish,
              Math.max(50, Math.floor(remaining / 3)),
            );
            wakeRenewal = finish;
            work.signal.addEventListener("abort", finish, { once: true });
          });
          if (!renewing || work.signal.aborted) return;
          const renewed = await transport.json<{ leaseExpiresAt: string }>(
            `/v1/actions/${segment(action.actionId)}/heartbeat`,
            "POST",
            {
              requestId: id(),
              claimId: claim.claimId,
              generation: claim.generation,
            },
            work.signal,
          );
          expires = Date.parse(renewed.leaseExpiresAt);
        }
      })().catch((error) => {
        if (renewing && !work.signal.aborted) {
          work.abort(error);
          report(error);
        }
      });
      const outcome = await executeAction(claim.action, agent, work.signal, {
        sandbox: (claim.sandbox ?? definitionDeclaresSandbox(agent.manifest))
          ? createActionSandbox({
              transport,
              actionId: action.actionId,
              claimId: claim.claimId,
              generation: claim.generation,
              signal: work.signal,
            })
          : undefined,
      });
      work.signal.throwIfAborted();
      const command = {
        type: "action_result",
        requestId: id(),
        idempotencyKey: `action:${action.actionId}:${claim.generation}`,
        actionId: action.actionId,
        claimId: claim.claimId,
        generation: claim.generation,
        outcome,
      };
      // Retrying delivery never re-invokes the tool/hook. Lost acknowledgements use the same receipt key.
      for (let attempt = 0; ; attempt++) {
        try {
          await transport.json(
            `/v1/sessions/${segment(action.sessionId)}/commands`,
            "POST",
            command,
            work.signal,
          );
          break;
        } catch (error) {
          if (
            work.signal.aborted ||
            attempt >= 4 ||
            (error instanceof RuntimeError &&
              error.status < 500 &&
              ![408, 429].includes(error.status))
          )
            throw error;
          await delay(Math.min(4000, 250 * 2 ** attempt), work.signal);
        }
      }
    } finally {
      renewing = false;
      wakeRenewal?.();
      await renewal;
      signal.removeEventListener("abort", stop);
    }
  };
  const loop = (async () => {
    let retry = 250;
    while (!signal.aborted) {
      const subscription = new AbortController();
      const stop = () => subscription.abort(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      try {
        const response = await transport.request("/v1/executors/connect", {
          signal: subscription.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          throw new Error("Executor endpoint did not return SSE");
        // Subscription exists before initial discovery; notifications can safely accumulate in its stream.
        await discover();
        resolveReady();
        for await (const frame of readSSE(response, subscription.signal)) {
          retry = 250;
          if (
            frame.event === "work_available" ||
            (frame.data && JSON.parse(frame.data).type === "work_available")
          )
            await discover();
        }
      } catch (error) {
        if (signal.aborted) break;
        report(error);
        if (
          error instanceof RuntimeError &&
          [400, 401, 403, 404].includes(error.status)
        ) {
          rejectReady(error);
          controller.abort(error);
          break;
        }
      } finally {
        subscription.abort();
        signal.removeEventListener("abort", stop);
      }
      if (!signal.aborted) await delay(retry, signal).catch(() => {});
      retry = Math.min(30000, retry * 2);
    }
    rejectReady(signal.reason ?? new Error("Executor connection closed"));
  })();
  return {
    ready,
    async close() {
      controller.abort(new Error("Executor connection closed"));
      for (const work of active.values()) work.abort(signal.reason);
      await loop;
    },
  };
}

function connectApplicationMode(
  options: ConnectOptions,
  application: AgentsClient,
  agents: Map<string, ExecutableDefinition>,
): AgentConnection {
  const version = implementationVersionOf(options);
  const children: AgentConnection[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});

  const boot = (async () => {
    const embedded = embeddedAgents.get(agents) ?? new Set<string>();
    for (const agent of agents.values()) {
      if (embedded.has(agent.id)) continue;
      await application.saveAgent(agent, { implementationVersion: version });
    }
    const registrations = [...agents.values()].map((agent) => {
      const manifestHash = flowManifestHash(agent);
      return {
        agentId: agent.id,
        token: deriveExecutorToken(
          application.transport.key,
          application.transport.tenant,
          agent.id,
        ),
        implementationVersion: version,
        ...(manifestHash === undefined ? {} : { manifestHash }),
      };
    });
    await application.transport.json("/v1/executors", "PUT", {
      executors: registrations,
    });
    for (const agent of agents.values()) {
      const token = deriveExecutorToken(
        application.transport.key,
        application.transport.tenant,
        agent.id,
      );
      const child = connectExecutorMode(
        {
          agents: [agent as AgentSource],
          implementationVersion: version,
          onError: options.onError,
        },
        {
          url: application.transport.url,
          tenant: application.transport.tenant,
          key: token,
          fetch: application.transport.fetcher,
        },
        new Map([[agent.id, agent]]),
      );
      children.push(child);
    }
    await Promise.all(children.map((child) => child.ready));
    resolveReady();
  })().catch((error) => {
    rejectReady(error);
  });

  return {
    ready,
    async close() {
      await boot.catch(() => {});
      await Promise.allSettled(children.map((child) => child.close()));
    },
  };
}

export function connectAgents(options: ConnectOptions): AgentConnection {
  const agents = buildAgents(options);

  // D§7.2 mode table: runtime → executor; application → application;
  // neither → resolveConnection() role.
  if (options.runtime) {
    return connectExecutorMode(options, options.runtime, agents);
  }
  if (options.application) {
    return connectApplicationMode(options, options.application, agents);
  }

  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  let handle: AgentConnection | undefined;

  const boot = (async () => {
    const connection = await resolveConnection();
    if (connection.role === "executor") {
      handle = connectExecutorMode(
        options,
        {
          url: connection.url,
          tenant: connection.tenant,
          key: connection.key,
        },
        agents,
      );
    } else {
      const application = new AgentsClient({
        url: connection.url,
        tenant: connection.tenant,
        key: connection.key,
      });
      handle = connectApplicationMode(options, application, agents);
    }
    await handle.ready;
    resolveReady();
  })().catch((error) => {
    rejectReady(error);
  });

  return {
    ready,
    async close() {
      await boot.catch(() => {});
      await handle?.close();
    },
  };
}

export { deriveExecutorToken };
