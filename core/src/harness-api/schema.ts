/**
 * Schemas of the Harness API's frames and payloads. A socket validates every frame it
 * receives; the in-process channel does in JSON mode (tests). Engine documents (manifests,
 * checkpoints, outcomes) are checked by the engine and the record, not here.
 */
import { z } from "zod";
import {
  ABORT_REASONS,
  HARNESS_API_VERSION,
  HARNESS_CLAIMS,
  HARNESS_ERROR_CODES,
} from "./messages.js";
import { HarnessApiError } from "./errors.js";
import { SANDBOX_TOOL_NAMES } from "../utils/sandbox.js";

const id = z.string().min(1).max(512);
const runId = z.object({ runId: id });
const outcome = z.object({ value: z.unknown(), statePatch: z.record(z.string(), z.unknown()).optional() }).strict();
const update = z
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

const workspaceRecord = z
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

const workspaceCall = z
  .object({
    session: z
      .object({ ownerId: id, sandboxId: id.optional(), activeTurnId: id.nullable() })
      .strict(),
    spec: z.unknown(),
    tool: z.enum(SANDBOX_TOOL_NAMES),
    input: z.unknown(),
  })
  .strict();

const workspaceBytes = z
  .object({
    session: workspaceCall.shape.session,
    spec: z.unknown(),
    bytes: z.object({ path: z.string().min(1), maxBytes: z.number().int().positive() }).strict(),
  })
  .strict();

const workspaceList = z
  .object({
    session: workspaceCall.shape.session,
    spec: z.unknown(),
    list: z.object({ dir: z.string().min(1), maxEntries: z.number().int().positive() }).strict(),
  })
  .strict();

const grant = z
  .object({
    runId: id,
    sessionId: id,
    turnId: id,
    epoch: z.number().int(),
    token: z.string().optional(),
    tokenExpiresAt: z.string().optional(),
  })
  .strict();

export const TurnStartSchema = z
  .object({
    type: z.enum(["turn.start", "approval.answer"]),
    engine: z.enum(["agent", "flow"]),
    manifest: z.record(z.string(), z.unknown()),
    checkpoint: z.record(z.string(), z.unknown()),
    sessionTools: z.array(z.unknown()).optional(),
    outcomes: z.array(z.object({ effectId: id, requestHash: z.string(), outcome }).strict()),
    transcript: z.object({ cursor: z.number().int() }).strict(),
    options: z
      .object({
        yieldAfter: z.object({ steps: z.number().optional(), ms: z.number().optional() }).strict().optional(),
        flowLimits: z.unknown().optional(),
        fixtureModel: z.boolean(),
      })
      .strict(),
    routing: z
      .object({
        rootManifest: z.record(z.string(), z.unknown()),
        mcpSnapshot: z.unknown().optional(),
        sandbox: z
          .object({ ownerId: id, sandboxId: id.optional(), spec: z.unknown().optional() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const TurnOutputSchema = z
  .object({
    runId: id,
    status: z.enum(["completed", "paused", "yielded", "waiting", "uncertain", "failed", "cancelled"]).optional(),
    state: z.unknown().optional(),
    output: z.unknown().optional(),
    pending: z.unknown().optional(),
    error: z.unknown().optional(),
    effectIds: z.array(z.string()).optional(),
    cancelEffectIds: z.array(z.string()).optional(),
    transcript: z.array(update).optional(),
    thrown: z.object({ code: z.string().optional(), message: z.string() }).strict().optional(),
  })
  .strict();

const settled = z.object({ cursor: z.number().int().optional() }).strict();
const empty = z.object({}).strict();
const outcomeObject = z.record(z.string(), z.unknown());

const requests: Record<string, { params: z.ZodType; result: z.ZodType }> = {
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
    result: z.object({ run: grant, input: TurnStartSchema }).strict(),
  },
  "lease.renew": {
    params: runId.strict(),
    result: z.union([
      z.object({ ok: z.literal(true), token: z.string().optional(), tokenExpiresAt: z.string().optional() }).strict(),
      z.object({ ok: z.literal(false) }).strict(),
    ]),
  },
  "lease.release": {
    params: runId.extend({ reason: z.enum(["shutdown", "ownership.lost", "connection.lost"]) }).strict(),
    result: empty,
  },
  "effect.intent": {
    params: runId.extend({ effect: EffectIntentSchema, requestHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    result: z.union([
      z.object({ status: z.literal("completed"), outcome }).strict(),
      z.object({ status: z.enum(["pending", "uncertain"]) }).strict(),
      z.object({ status: z.literal("execute"), rejoin: z.literal(true).optional() }).strict(),
    ]),
  },
  "effect.outcome": {
    params: z.union([
      runId.extend({ effectId: id, value: z.unknown() }).strict(),
      runId.extend({ effectId: id, error: z.string() }).strict(),
    ]),
    result: z.union([
      z.object({ status: z.literal("completed"), outcome }).strict(),
      z.object({ status: z.literal("uncertain") }).strict(),
    ]),
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
        record: workspaceRecord.optional(),
      })
      .strict(),
    result: empty,
  },
  "session.mcp": {
    params: runId.extend({ snapshot: z.unknown().optional(), diagnostics: z.array(z.unknown()) }).strict(),
    result: z.object({ snapshot: z.unknown(), sessionTools: z.array(z.unknown()) }).strict(),
  },
  "definition.file": {
    params: runId.extend({ sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict(),
    result: z.object({ base64: z.string() }).strict(),
  },
  "turn.completed": { params: TurnOutputSchema, result: settled },
  "turn.paused": { params: TurnOutputSchema, result: settled },
  "turn.waiting": { params: TurnOutputSchema, result: settled },
  "turn.failed": { params: TurnOutputSchema, result: settled },
  checkpoint: { params: TurnOutputSchema, result: settled },
  "workspace.read": { params: z.union([workspaceCall, workspaceBytes, workspaceList]), result: outcomeObject },
  "workspace.write": { params: workspaceCall, result: outcomeObject },
  "workspace.exec": { params: workspaceCall, result: outcomeObject },
  "workspace.report": { params: empty, result: outcomeObject },
  "workspace.sweep": {
    params: z.object({ now: z.number().optional() }).strict(),
    result: z.object({ workspaces: z.array(workspaceRecord) }).strict(),
  },
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
};

const messages: Record<string, z.ZodType> = {
  cancel: runId
    .extend({ reason: z.enum(ABORT_REASONS as [string, ...string[]]), message: z.string().optional() })
    .strict(),
};

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
