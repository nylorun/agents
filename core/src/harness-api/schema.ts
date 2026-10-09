/**
 * Schemas of the Harness API's frames and payloads, and the source of its types (`messages.ts`
 * infers each from its schema). A socket validates every frame it receives; the in-process
 * channel does in JSON mode (tests). Engine documents (manifests, checkpoints, outcomes) are
 * checked by the engine and the record, not here.
 */
import { z } from "zod";
import {
  ABORT_REASONS,
  HARNESS_API_VERSION,
  HARNESS_CLAIMS,
  HARNESS_ERROR_CODES,
} from "./messages.js";
import { HarnessApiError } from "./errors.js";
import { EffectOutcomeSchema } from "../contracts.js";
import { SANDBOX_TOOL_NAMES } from "../utils/sandbox.js";

const id = z.string().min(1).max(512);
const runId = z.object({ runId: id });
/** An engine document (a manifest, a checkpoint): an object here, which the engine checks. */
const document: z.ZodType<object> = z.record(z.string(), z.unknown());

/** The payload of one `transcript.updated` event. */
export const TranscriptUpdateSchema = z
  .object({ keep: z.number().int().min(0), entries: z.array(z.unknown()), length: z.number().int().min(0) })
  .strict();

export const FrameSchema = z.union([
  z.object({ t: z.literal("req"), id: z.number().int().positive(), m: z.string().min(1), p: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: z.number().int().positive(), ok: z.literal(true), r: z.unknown() }).strict(),
  z
    .object({
      t: z.literal("res"),
      id: z.number().int().positive(),
      ok: z.literal(false),
      e: z.object({ code: z.enum(HARNESS_ERROR_CODES), message: z.string() }).strict(),
    })
    .strict(),
  z.object({ t: z.literal("msg"), m: z.string().min(1), p: z.unknown() }).strict(),
  z.object({ t: z.literal("abort"), id: z.number().int().positive() }).strict(),
  z.object({ t: z.literal("ping") }).strict(),
]);

/** One effect the engine asks for: a `HostEffect`, by structure. Model intents carry no `input`. */
export const EffectIntentSchema = z
  .object({
    effectId: id,
    sessionId: id,
    turnId: id,
    agentId: id,
    manifestHash: z.string(),
    kind: z.enum(["model", "tool", "delegation", "agent"]),
    agent: z.object({ id: z.string(), path: z.string(), delegationId: z.string().optional() }).strict().optional(),
    capabilityId: z.string().optional(),
    toolName: z.string().optional(),
    path: z.string().optional(),
    key: z.string().optional(),
    iterations: z.string().optional(),
    input: z.unknown().optional(),
    context: z.record(z.string(), z.unknown()),
  })
  .strict();

/** A completed outcome of the segment, with the hash of the request it answered. */
export const RecordedOutcomeSchema = z
  .object({ effectId: id, requestHash: z.string(), outcome: EffectOutcomeSchema })
  .strict();

/** A workspace's compute record, as the harness keeps it. */
export const WorkspaceRecordSchema = z
  .object({
    key: z.string().min(1).max(512),
    sessionId: id,
    sandboxId: id.optional(),
    backend: z.string(),
    image: z.string(),
    state: z.enum(["creating", "running", "stopped"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** The session a workspace request acts for: the workspace's owner and its sandbox resource. */
export const WorkspaceSessionSchema = z
  .object({
    /** The session that owns the workspace: its log records the workspace's events. */
    ownerId: id,
    sandboxId: id.optional(),
    activeTurnId: id.nullable(),
  })
  .strict();

/** A sandbox tool call core sends to the harness that serves workspaces. */
export const WorkspaceCallSchema = z
  .object({
    session: WorkspaceSessionSchema,
    /** The sandbox spec the workspace runs (`SandboxManifest`). */
    spec: z.unknown(),
    tool: z.enum(SANDBOX_TOOL_NAMES),
    input: z.unknown(),
  })
  .strict();

/**
 * A file of a workspace read as bytes (`save_artifact`, F8.1), at most `maxBytes`. The answer is
 * `{kind: "read", path, base64}`, `{kind: "missing", path}` or a failed tool outcome.
 */
export const WorkspaceBytesCallSchema = z
  .object({
    session: WorkspaceSessionSchema,
    spec: z.unknown(),
    bytes: z.object({ path: z.string().min(1), maxBytes: z.number().int().positive() }).strict(),
  })
  .strict();

/**
 * The regular files under a directory of a workspace, recursively, at most `maxEntries + 1`
 * (the turn-end export, F8.2). The answer is `{kind: "listed", path, listing: {entries,
 * truncated}}`, `{kind: "missing", path}` (no sandbox yet, or not a directory) or a failed tool
 * outcome.
 */
export const WorkspaceListCallSchema = z
  .object({
    session: WorkspaceSessionSchema,
    spec: z.unknown(),
    list: z.object({ dir: z.string().min(1), maxEntries: z.number().int().positive() }).strict(),
  })
  .strict();

/** The lease on one run. `token` is the run token (F5) when the gates require one. */
export const RunGrantSchema = z
  .object({
    runId: id,
    sessionId: id,
    turnId: id,
    epoch: z.number().int(),
    token: z.string().optional(),
    tokenExpiresAt: z.string().optional(),
  })
  .strict();

/** Where a harness sends the session's tool calls. */
export const RunRoutingSchema = z
  .object({
    /** The session's pinned manifest: an effect's agent resolves against it. */
    rootManifest: document,
    mcpSnapshot: z.unknown().optional(),
    /** The session that owns the tree's sandbox, and the sandbox resource it is attached to. */
    sandbox: z
      .object({
        ownerId: id,
        sandboxId: id.optional(),
        spec: z.unknown().optional(),
        /**
         * Variables every sandbox command gets (R2c, D50): each `environment_secret` name set to
         * the sentinel `nylorun-managed`, and each `environment_variable`'s value. Never a secret.
         */
        environment: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** What a run starts from: `turn.start` (message, continue, resume) or `approval.answer`. */
export const TurnStartSchema = z
  .object({
    type: z.enum(["turn.start", "approval.answer"]),
    engine: z.enum(["agent", "flow"]),
    /** The turn's manifest (agent) or the workflow manifest (flow). */
    manifest: document,
    /** The segment's checkpoint; an agent's state has no transcript (`transcript.cursor`). */
    checkpoint: document,
    sessionTools: z.array(z.unknown()).readonly().optional(),
    /** Completed outcomes of this segment, resolved without asking core. */
    outcomes: z.array(RecordedOutcomeSchema).readonly(),
    /** The record position the session's transcript was folded at. */
    transcript: z.object({ cursor: z.number().int() }).strict(),
    options: z
      .object({
        yieldAfter: z.object({ steps: z.number().optional(), ms: z.number().optional() }).strict().optional(),
        flowLimits: z.unknown().optional(),
        fixtureModel: z.boolean(),
      })
      .strict(),
    routing: RunRoutingSchema,
  })
  .strict();

/**
 * A segment's end. `state` is the agent's engine state without its transcript; `transcript`
 * edits the transcript the segment started from. `thrown` reports an engine that threw.
 */
export const TurnOutputSchema = z
  .object({
    runId: id,
    /** How the segment ended, as the harness reports it. */
    status: z.enum(["completed", "paused", "yielded", "waiting", "uncertain", "failed", "cancelled"]).optional(),
    state: z.unknown().optional(),
    output: z.unknown().optional(),
    pending: z.unknown().optional(),
    error: z.unknown().optional(),
    effectIds: z.array(z.string()).readonly().optional(),
    cancelEffectIds: z.array(z.string()).readonly().optional(),
    transcript: z.array(TranscriptUpdateSchema).readonly().optional(),
    thrown: z.object({ code: z.string().optional(), message: z.string() }).strict().optional(),
  })
  .strict();

/** Why a harness gave a run back without an output. */
export const ReleaseReasonSchema = z.enum(["shutdown", "ownership.lost", "connection.lost"]);

export const IntentAnswerSchema = z.union([
  z.object({ status: z.literal("completed"), outcome: EffectOutcomeSchema }).strict(),
  z.object({ status: z.enum(["pending", "uncertain"]) }).strict(),
  z.object({ status: z.literal("execute"), rejoin: z.literal(true).optional() }).strict(),
]);

export const OutcomeAnswerSchema = z.union([
  z.object({ status: z.literal("completed"), outcome: EffectOutcomeSchema }).strict(),
  z.object({ status: z.literal("uncertain") }).strict(),
]);

const settled = z.object({ cursor: z.number().int().optional() }).strict();
const empty = z.object({}).strict();
const outcomeObject = z.record(z.string(), z.unknown());

type RequestSchemas = Record<string, { params: z.ZodType; result: z.ZodType }>;

/** The params and result of each request, as its schemas infer them. */
export type RequestTypes<Schemas extends RequestSchemas> = {
  [M in keyof Schemas]: { params: z.infer<Schemas[M]["params"]>; result: z.infer<Schemas[M]["result"]> };
};

/** Requests a harness sends to core, with their answers. */
export const harnessRequests = {
  /**
   * `capabilities.workspace` declares that the harness serves the Tenant's workspaces (F6.2):
   * core then sends it the `workspace.*` requests. The answer names the Tenant (its workspace
   * keys are scoped by it) and the sandbox backend preference the harness selects with.
   */
  hello: {
    params: z
      .object({
        api: z.number().int(),
        name: z.string(),
        version: z.string(),
        capabilities: z.object({ workspace: z.unknown().optional() }).strict(),
      })
      .strict(),
    result: z
      .object({
        api: z.literal(HARNESS_API_VERSION),
        tenantId: id,
        sandbox: z.object({ backend: z.string().nullable() }).strict(),
        renewEveryMs: z.number().int().positive(),
      })
      .strict(),
  },
  lease: {
    params: z.object({ slots: z.number().int().positive().optional() }).strict(),
    result: z.object({ run: RunGrantSchema, input: TurnStartSchema }).strict(),
  },
  "lease.renew": {
    params: runId.strict(),
    result: z.union([
      z.object({ ok: z.literal(true), token: z.string().optional(), tokenExpiresAt: z.string().optional() }).strict(),
      z.object({ ok: z.literal(false) }).strict(),
    ]),
  },
  "lease.release": {
    params: runId.extend({ reason: ReleaseReasonSchema }).strict(),
    result: empty,
  },
  "effect.intent": {
    params: runId.extend({ effect: EffectIntentSchema, requestHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    result: IntentAnswerSchema,
  },
  "effect.outcome": {
    params: z.union([
      runId.extend({ effectId: id, value: z.unknown() }).strict(),
      runId.extend({ effectId: id, error: z.string() }).strict(),
    ]),
    result: OutcomeAnswerSchema,
  },
  "transcript.read": {
    params: runId.strict(),
    result: z.object({ cursor: z.number().int(), entries: z.array(z.unknown()) }).strict(),
  },
  event: {
    params: z
      .object({
        runId: id.optional(),
        sessionId: id,
        turnId: id.nullable(),
        type: z.enum(HARNESS_CLAIMS),
        payload: z.unknown(),
        /** With `sandbox.state`: the workspace's compute record as it is now. */
        record: WorkspaceRecordSchema.optional(),
      })
      .strict(),
    result: empty,
  },
  "session.mcp": {
    params: runId.extend({ snapshot: z.unknown().optional(), diagnostics: z.array(z.unknown()) }).strict(),
    result: z.object({ snapshot: z.unknown(), sessionTools: z.array(z.unknown()) }).strict(),
  },
  /**
   * A definition file's bytes, base64 (track R2 M4): one the run's definition names, for the
   * skills its sandbox mounts.
   */
  "definition.file": {
    params: runId.extend({ sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict(),
    result: z.object({ base64: z.string() }).strict(),
  },
  "turn.completed": { params: TurnOutputSchema, result: settled },
  "turn.paused": { params: TurnOutputSchema, result: settled },
  "turn.waiting": { params: TurnOutputSchema, result: settled },
  "turn.failed": { params: TurnOutputSchema, result: settled },
  /** A yielded segment's state: ends the run, the turn goes on in the next. */
  checkpoint: { params: TurnOutputSchema, result: settled },
} satisfies RequestSchemas;

/**
 * Requests core sends to a harness that declared `workspace` (F6.2), with their answers. A
 * sandbox tool's answer is its `SandboxToolOutcome`; the harness claims its `sandbox.*` events
 * while the request is in flight. `workspace.read` stays generic: F8.2 exports outputs
 * through it.
 */
export const coreRequests = {
  "workspace.read": {
    params: z.union([WorkspaceCallSchema, WorkspaceBytesCallSchema, WorkspaceListCallSchema]),
    result: outcomeObject,
  },
  "workspace.write": { params: WorkspaceCallSchema, result: outcomeObject },
  "workspace.exec": { params: WorkspaceCallSchema, result: outcomeObject },
  /** The harness's sandbox selection report (`GET /v1/tenant/sandbox`, Tenant status). */
  "workspace.report": { params: empty, result: outcomeObject },
  /** Stops idle workspaces, then lists every workspace the harness keeps. */
  "workspace.sweep": {
    params: z.object({ now: z.number().optional() }).strict(),
    result: z.object({ workspaces: z.array(WorkspaceRecordSchema) }).strict(),
  },
  /** Deletes workspaces with their files: by key, by sandbox resource, or all of them. */
  "workspace.remove": {
    params: z
      .object({
        keys: z.array(z.string().min(1)).optional(),
        sandboxIds: z.array(id).optional(),
        all: z.literal(true).optional(),
      })
      .strict(),
    result: empty,
  },
} satisfies RequestSchemas;

/** Messages core sends to a harness, without an answer. */
export const coreMessages = {
  /** `message` is core's abort message, which the run's executors see as theirs. */
  cancel: runId.extend({ reason: z.enum(ABORT_REASONS), message: z.string().optional() }).strict(),
} satisfies Record<string, z.ZodType>;

const requests: RequestSchemas = { ...harnessRequests, ...coreRequests };
const messages: Record<string, z.ZodType> = coreMessages;

function check(schema: z.ZodType | undefined, value: unknown, what: string): void {
  if (!schema) throw new HarnessApiError("invalid", `Unknown ${what}`);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HarnessApiError("invalid", `Invalid ${what}: ${parsed.error.issues[0]?.message ?? "malformed"}`);
}

export function validateFrame(frame: unknown): void {
  check(FrameSchema, frame, "frame");
}
export function validateParams(method: string, params: unknown): void {
  check(requests[method]?.params, params, `${method} request`);
}
export function validateResult(method: string, result: unknown): void {
  check(requests[method]?.result, result, `${method} answer`);
}
export function validateMessage(method: string, params: unknown): void {
  check(messages[method], params, `${method} message`);
}
