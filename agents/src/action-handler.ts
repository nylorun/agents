/**
 * An Action endpoint (design: Action endpoints): the application mounts this handler at a URL
 * and registers the URL; the Runtime POSTs each Action for the served agents to it and records
 * the answer as the Action's outcome. No stream, no claim, no key needed to serve.
 *
 * Each request is checked before any code runs: the delivery token must be signed by the
 * Tenant's signing key, be for this Tenant, this URL (once known), this Action and this
 * generation, and cover the exact body. The Action then runs through `executeAction`, with the
 * request's signal as `ctx.signal`.
 */
import {
  OUTCOME_HEADER,
  SIGNATURE_HEADER,
} from "@nylorun/core/compatibility";
import {
  ActionDeliverySchema,
  DeliveryHeartbeatResponseSchema,
  EndpointPingResponseSchema,
  PutEndpointsRequestSchema,
  type Action,
  type ActionOutcome,
  type EndpointPingResponse,
  type EndpointRegistration,
} from "@nylorun/core/contracts";
import type { BuiltWorkflow } from "@nylorun/core/define";
import { toNodeListener } from "./ag-ui/node.js";
import { createClient, type AgentSource, type AgentsClient } from "./client.js";
import {
  DeliveryVerificationError,
  JwksCache,
  verifyDeliveryToken,
} from "./delivery-token.js";
import {
  executeAction,
  runsInBackground,
  type ExecutableDefinition,
} from "./execute-action.js";
import { RuntimeError, Transport, delay, segment } from "./http.js";
import { createActionSandbox } from "./sandbox/client.js";
import {
  buildAgents,
  embeddedIn,
  flowManifestHash,
  implementationVersionOf,
} from "./served-definitions.js";

/** The Host feature `register` needs. */
const REQUIRED_FEATURE = "action-endpoints";

export interface ActionHandlerOptions {
  /** The agents and workflows this endpoint serves. Agents they embed are served too. */
  agents: readonly (AgentSource | BuiltWorkflow)[];
  /**
   * Application client, used by `register` (and, when `runtime` is not set, to read the
   * Tenant's public keys). Default: `createClient()`, from the environment or the Project link.
   */
  client?: AgentsClient | Promise<AgentsClient>;
  /**
   * Where to read the Tenant's public keys without a key. Set it for a process that only
   * serves Actions and holds no application key.
   */
  runtime?: { url: string; fetch?: typeof fetch };
  /** The Tenant's public keys, instead of reading them from the Runtime. */
  jwks?: { keys: readonly JsonWebKey[] };
  /**
   * The URL the Runtime calls, as registered. Every delivery token must name it. Default: the
   * URL passed to `register` in this process; until then, any URL of the Tenant.
   */
  url?: string;
  /** Registered with each endpoint. Default: `NYLORUN_IMPLEMENTATION_VERSION`, else `dev`. */
  implementationVersion?: string;
  /** Receives errors that are answered with a status instead of thrown. */
  onError?: (error: unknown) => void;
  /**
   * Keeps the process alive for a background tool's work after its `202` answer, on platforms
   * that end a request's work with its response (for example a serverless platform's
   * `waitUntil`). A Node server needs nothing.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

export interface RegisterOptions {
  /** The URL the Runtime calls, e.g. `http://localhost:3000/nylorun/actions`. */
  url: string;
  /** Save the definitions first. Default true. */
  saveDefinitions?: boolean;
  /** How long one inline delivery may take, in milliseconds. */
  timeoutMs?: number;
  /** In-flight deliveries per agent. */
  maxConcurrent?: number;
  signal?: AbortSignal;
}

export interface ActionHandler {
  /** A web-standard handler: Hono, Next.js route handlers, Workers, Bun, Deno. */
  fetch(request: Request): Promise<Response>;
  /** The same handler for `node:http` and Express. */
  readonly node: ReturnType<typeof toNodeListener>;
  /**
   * Saves the definitions, points the Runtime at `url` for every served agent and pings each
   * one through the Runtime, so a wrong URL or a tunnel that is down fails here.
   */
  register(options: RegisterOptions): Promise<EndpointPingResponse[]>;
}

export function createActionHandler(options: ActionHandlerOptions): ActionHandler {
  const agents = buildAgents(options.agents, "createActionHandler");
  const version = implementationVersionOf(options);
  let client: Promise<AgentsClient> | undefined;
  const clientOf = () =>
    (client ??= Promise.resolve(options.client ?? createClient()));
  let audience = options.url;
  let verification: Promise<Verification> | undefined;
  const verificationOf = () =>
    (verification ??= resolveVerification(options, clientOf)).catch((error) => {
      verification = undefined;
      throw error;
    });
  let callbacks: Transport | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {}
  };

  const handle = async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return answer(405, "method_not_allowed", "An Action endpoint accepts POST only");
    const body = new Uint8Array(await request.arrayBuffer());
    const { url, fetch, keys } = await verificationOf();
    const token = request.headers.get(SIGNATURE_HEADER);
    let claims;
    try {
      claims = await verifyDeliveryToken(token, {
        keys: keys.lookup,
        body,
        ...(audience === undefined ? {} : { audience }),
      });
    } catch (error) {
      if (!(error instanceof DeliveryVerificationError)) throw error;
      // A key this endpoint has not seen yet (a rotation within the refetch interval) is not
      // a refusal: the Runtime retries a 503, while a 401 would fail the Action.
      return answer(error.code === "key_unknown" ? 503 : 401, error.code, error.message);
    }
    let delivery;
    try {
      delivery = ActionDeliverySchema.parse(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return answer(400, "invalid_delivery", "The body is not an Action delivery");
    }

    if (delivery.type === "ping") {
      if (claims.sub !== "ping" || claims.agt !== delivery.agentId)
        return answer(401, "signature_invalid", "The token is for another delivery");
      const agent = agents.get(delivery.agentId);
      if (!agent) return notServed(delivery.agentId);
      const manifestHash = flowManifestHash(agent);
      return Response.json({
        agentId: agent.id,
        implementationVersion: version,
        ...(manifestHash === undefined ? {} : { manifestHash }),
      } satisfies EndpointPingResponse);
    }

    const { action } = delivery;
    if (
      claims.sub !== action.actionId ||
      claims.gen !== action.generation ||
      claims.agt !== action.agentId
    )
      return answer(401, "signature_invalid", "The token is for another delivery");
    const agent = agents.get(action.agentId);
    if (!agent) return notServed(action.agentId);
    const served = flowManifestHash(agent);
    if (served !== undefined && "key" in action && action.manifestHash !== served)
      return answer(
        409,
        "version_mismatch",
        `Action ${action.actionId} belongs to manifest ${action.manifestHash} of '${action.agentId}'; this endpoint serves ${served}`,
      );
    if (runsInBackground(action, agent)) {
      const work = runInBackground({
        action,
        agent,
        token: token!,
        sandbox: delivery.sandbox,
        runtime: { url, ...(fetch ? { fetch } : {}) },
        report,
      });
      options.waitUntil?.(work);
      return new Response(null, { status: 202 });
    }
    const sandbox = delivery.sandbox
      ? createActionSandbox({
          transport: (callbacks = callbacks
            ? callbacks.withKey(token!)
            : new Transport({ url, key: token!, ...(fetch ? { fetch } : {}) })),
          actionId: action.actionId,
          signal: request.signal,
        })
      : undefined;
    try {
      const outcome = await executeAction(action, agent, request.signal, {
        ...(sandbox ? { sandbox } : {}),
      });
      return Response.json(outcome, { headers: { [OUTCOME_HEADER]: "1" } });
    } catch (error) {
      if (request.signal.aborted)
        return answer(503, "aborted", "The Runtime closed the delivery");
      // Tool errors are outcomes; a throw means this endpoint cannot run the Action at all.
      report(error);
      return answer(
        404,
        "action_not_served",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const fetchHandler = async (request: Request) => {
    try {
      return await handle(request);
    } catch (error) {
      report(error);
      // Not run: the Runtime retries a 503 whatever the Action's kind.
      return answer(503, "endpoint_unavailable", error instanceof Error ? error.message : String(error));
    }
  };

  return {
    fetch: fetchHandler,
    node: toNodeListener({ fetch: fetchHandler }),
    async register(register) {
      const application = await clientOf();
      const { transport } = application;
      await transport.requireFeature(REQUIRED_FEATURE, register.signal);
      if (register.saveDefinitions ?? true) {
        const embedded = embeddedIn(agents);
        for (const agent of agents.values())
          if (!embedded.has(agent.id))
            await application.saveAgent(agent, { implementationVersion: version });
      }
      const endpoints = [...agents.values()].map((agent): EndpointRegistration => {
        const manifestHash = flowManifestHash(agent);
        return {
          agentId: agent.id,
          url: register.url,
          implementationVersion: version,
          ...(manifestHash === undefined ? {} : { manifestHash }),
          ...(register.timeoutMs === undefined ? {} : { timeoutMs: register.timeoutMs }),
          ...(register.maxConcurrent === undefined
            ? {}
            : { maxConcurrent: register.maxConcurrent }),
        };
      });
      await transport.json(
        "/v1/endpoints",
        "PUT",
        PutEndpointsRequestSchema.parse({ endpoints }),
        register.signal,
      );
      audience = register.url;
      const answers: EndpointPingResponse[] = [];
      for (const agent of agents.values())
        answers.push(
          EndpointPingResponseSchema.parse(
            await transport.json(
              `/v1/endpoints/${segment(agent.id)}/ping`,
              "POST",
              {},
              register.signal,
            ),
          ),
        );
      return answers;
    },
  };
}

/** How long a background tool waits before its first heartbeat, and after a failed one. */
const HEARTBEAT_RETRY_MS = 1_000;

/**
 * A background tool (`ToolDefinition.background`): runs after the `202` answer, heartbeats on
 * the deadline the Runtime returns, stops when a heartbeat answers `409` (cancelled, lost or
 * sent again), and posts its outcome. Every callback uses the newest delivery token.
 */
async function runInBackground(input: {
  action: Action;
  agent: ExecutableDefinition;
  token: string;
  sandbox: boolean;
  runtime: { url: string; fetch?: typeof fetch };
  report: (error: unknown) => void;
}): Promise<void> {
  const { action, report } = input;
  let current = new Transport({ ...input.runtime, key: input.token });
  const live = {
    json: (...args: Parameters<Transport["json"]>) => current.json(...args),
  } as unknown as Transport;
  const path = `/v1/actions/${segment(action.actionId)}`;
  const stop = new AbortController();
  const done = new AbortController();
  const heartbeats = (async () => {
    let wait = HEARTBEAT_RETRY_MS;
    while (!done.signal.aborted && !stop.signal.aborted) {
      try {
        await delay(wait, done.signal);
      } catch {
        return;
      }
      try {
        const renewed = DeliveryHeartbeatResponseSchema.parse(
          await current.json(`${path}/heartbeat`, "POST", undefined, done.signal),
        );
        current = current.withKey(renewed.token);
        wait = Math.max(
          HEARTBEAT_RETRY_MS,
          Math.floor((Date.parse(renewed.deadlineAt) - Date.now()) / 3),
        );
      } catch (error) {
        if (done.signal.aborted) return;
        if (error instanceof RuntimeError && error.status === 409) {
          stop.abort(error);
          return;
        }
        report(error);
        wait = HEARTBEAT_RETRY_MS;
      }
    }
  })();
  let outcome: ActionOutcome;
  try {
    outcome = await executeAction(action, input.agent, stop.signal, {
      ...(input.sandbox
        ? { sandbox: createActionSandbox({ transport: live, actionId: action.actionId, signal: stop.signal }) }
        : {}),
    });
  } catch (error) {
    // Not served here: say so rather than leave the Runtime waiting for the deadline.
    report(error);
    outcome = {
      value: {
        kind: "failed",
        code: "action_not_served",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    done.abort();
  }
  await heartbeats;
  if (stop.signal.aborted) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await current.json(`${path}/result`, "POST", outcome);
      return;
    } catch (error) {
      if (
        attempt >= 4 ||
        (error instanceof RuntimeError && error.status < 500 && error.status !== 429)
      ) {
        report(error);
        return;
      }
      await delay(Math.min(4_000, 250 * 2 ** attempt), new AbortController().signal);
    }
  }
}

interface Verification {
  /** The Runtime's URL, for sandbox calls made with the delivery token. */
  url: string;
  fetch?: typeof fetch;
  keys: JwksCache;
}

async function resolveVerification(
  options: ActionHandlerOptions,
  clientOf: () => Promise<AgentsClient>,
): Promise<Verification> {
  if (options.runtime) {
    const { url, fetch } = options.runtime;
    return {
      url,
      ...(fetch ? { fetch } : {}),
      keys: new JwksCache(options.jwks ?? { url, ...(fetch ? { fetch } : {}) }),
    };
  }
  const { transport } = await clientOf();
  return {
    url: transport.url,
    fetch: transport.fetcher,
    keys: new JwksCache(
      options.jwks ?? {
        url: transport.url,
        key: transport.key,
        fetch: transport.fetcher,
      },
    ),
  };
}

function notServed(agentId: string): Response {
  return answer(404, "agent_not_served", `This endpoint does not serve '${agentId}'`);
}

function answer(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}
