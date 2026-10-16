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
import { ARTIFACT_NAME_MAX, ENVIRONMENT_KINDS, EffectOutcomeSchema, ModelInputSchema } from "../contracts.js";
import { HarnessLimitsSchema, RUNTIME_LIMIT_CEILINGS } from "../utils/runtime-limits.js";
import { SANDBOX_TOOL_NAMES } from "../utils/sandbox.js";
import { McpFactsSchema, McpSnapshotSchema } from "./mcp.js";

/** An id in a Harness API frame, at most 512 characters: an identifier's grammar is the protocol's (it crosses the Runtime API, the Harness API and tokens, and means the same in every installation), so its length is a constant of protocol 15, not a setting. */
const id = z.string().min(1).max(512);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const runId = z.object({ runId: id });
/** An engine document (a manifest, a checkpoint): an object here, which the engine checks. */
const document: z.ZodType<object> = z.record(z.string(), z.unknown());

const edit = { keep: z.number().int().min(0), entries: z.array(z.unknown()), length: z.number().int().min(0) };

/**
 * What a harness says of a compaction it made (protocol 15): why, its estimated tokens before and
 * after, and the model calls of this turn that wrote the summary (`purpose: "summary"`), in
 * order. Core checks them and writes one `context.compacted` from them and the last call.
 */
export const CompactionFactsSchema = z
  .object({
    trigger: z.enum(["threshold", "overflow"]),
    tokensBefore: z.number().int().min(0),
    tokensAfter: z.number().int().min(0),
    summaryEffectIds: z.array(id).min(1),
  })
  .strict();

/**
 * The payload of one `transcript.updated` event: keep the first `keep` entries, append `entries`,
 * giving `length` entries. A harness that replaced older history with a summary marks the edit
 * `kind: "compaction"` with its facts (the first chunk of the edit; the record never parses the
 * entries to find one).
 */
export const TranscriptUpdateSchema = z.union([
  z.object(edit).strict(),
  z.object({ kind: z.literal("compaction"), ...edit, compaction: CompactionFactsSchema }).strict(),
]);

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

/**
 * What a tool call runs (protocol 15). The record routes a call by its target, never by the
 * tool's name: the name the model used (`toolName`) is for display, and no name is reserved.
 *
 * - `mcp`: the tool `tool` (its own name on the server) of the MCP server `server` that the call's
 *   agent declares (`effect.agent`, absent for the root), as the session discovered it
 *   (`turn.start.mcp`); the harness calls it through the Tool Gate. The record refuses one the
 *   session did not discover (`tool.unknown`) or the turn disables (`tool.disabled`).
 * - `http`: the HTTP tool the agent declares as `tool`; the harness calls it through the Tool Gate.
 * - `sandbox`: one of the sandbox operations (`bash`, `read`, `write`, `edit`, `grep`, `glob`,
 *   named by `toolName`) in the session's sandbox, which the harness runs. Only a session with a
 *   sandbox runs one.
 * - `harness`: a tool the harness runs in its own process over the Harness API's seams, such as
 *   our engine's `load_skill`, `read_artifact` and `tool_search`. Its egress gate is its only
 *   control.
 *
 * Tool policy and approval key on the identity (`server` and `tool`, or the HTTP tool's declared
 * name), never on the model's name. A tool call without a target, or with one the session lacks,
 * fails to the model (`tool.unavailable`), and nothing runs.
 */
export const EffectTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcp"), server: z.string().min(1), tool: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("http"), tool: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("sandbox") }).strict(),
  z.object({ kind: z.literal("harness") }).strict(),
]);

/**
 * One effect the engine asks for: a `HostEffect`, by structure. Model intents carry no `input`.
 * `context` carries the ids the record derives its events from: a model effect's
 * `invocationId` (the step), and a tool effect's `callId` (the model's tool call id) and
 * `invocationId`; without them the call is journaled but no `tool.completed` is written. A
 * tool effect may name its step (`stepId`).
 *
 * A model effect that writes a compaction's summary says so (`purpose: "summary"`): it is no
 * assistant message, and the compaction edit that follows names it (`CompactionFactsSchema`).
 *
 * An agent's tool effect names its `target` (what runs it: for an MCP or HTTP tool, its
 * identity) beside the name the model used (`toolName`, for display), and may name the `skill` it
 * ran (a skill tool's skill, or a sandbox call in a skill's folder): the record keeps the skill,
 * and the plugin that brought it, when the agent has that skill. The target is in the request
 * hash, so a replay that names another tool is `effect_drift`.
 *
 * Each outcome the harness reports is one record entry: past `turn.start.limits.recordEntryBytes`
 * it is refused (`limit_exceeded`), so a harness stores a large tool result with
 * `artifact.write` and reports a preview.
 *
 * `requestHash` (`effectRequestHash`) covers the whole request: for a model effect, the intent
 * with `input` set to its `ModelCall`, though the intent is sent without it. A replay that asks
 * for the same id with another hash is `effect_drift`.
 */
export const EffectIntentSchema = z
  .object({
    effectId: id,
    sessionId: id,
    turnId: id,
    agentId: id,
    manifestHash: z.string(),
    kind: z.enum(["model", "tool", "delegation", "agent"]),
    agent: z.object({ id: z.string(), path: z.string(), delegationId: z.string().optional() }).strict().optional(),
    toolName: z.string().optional(),
    target: EffectTargetSchema.optional(),
    skill: z.string().min(1).optional(),
    /** A model call that summarizes history for a compaction: the record writes no `message.assistant` for it. */
    purpose: z.literal("summary").optional(),
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

/**
 * An artifact as the artifact seam shows it to a harness: one version of a file (or a folder,
 * whose bytes the seam does not serve). `tenantWide` marks a Tenant-wide artifact (no session),
 * which the run reads only because the session's messages named it.
 */
export const ArtifactMetaSchema = z
  .object({
    artifactId: id,
    kind: z.enum(["file", "folder"]),
    name: z.string(),
    version: z.number().int().min(1),
    contentType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    tenantWide: z.boolean(),
  })
  .strict();

/** A workspace's compute record, as the harness keeps it. */
export const WorkspaceRecordSchema = z
  .object({
    key: id,
    sessionId: id,
    environmentId: id.optional(),
    backend: z.string(),
    image: z.string(),
    state: z.enum(["creating", "running", "stopped"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** The session a workspace request acts for, and the Environment whose workspace it is. */
export const WorkspaceSessionSchema = z
  .object({
    /** The session the request acts for: its log records the workspace's events. */
    ownerId: id,
    environmentId: id.optional(),
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
 * One operation on the disk of a workspace (R2d step 3): `list` its entries (files with mode and
 * modification time, links, empty directories; paths relative to the volume, `workspace/…` and
 * in a pod `harness/…`), `read` a range of one file (answered `{kind: "read", base64, eof}`),
 * `clear` it (the engine's own files stay), or `put` entries back in order. A `workspace.read`
 * carries `list` or `read`; a `workspace.write` `clear` or `put`.
 */
export const DiskOpSchema = z.union([
  z.object({ list: z.object({ maxEntries: z.number().int().positive() }).strict() }).strict(),
  z
    .object({
      read: z
        .object({
          path: z.string().min(1),
          offset: z.number().int().nonnegative(),
          length: z.number().int().positive().max(RUNTIME_LIMIT_CEILINGS.chunkBytes.value),
        })
        .strict(),
    })
    .strict(),
  z.object({ clear: z.literal(true) }).strict(),
  z
    .object({
      put: z.array(
        z
          .object({
            path: z.string().min(1),
            type: z.enum(["file", "dir", "link"]),
            mode: z.number().int().nonnegative().optional(),
            mtimeMs: z.number().nonnegative().optional(),
            base64: z.string().optional(),
            append: z.boolean().optional(),
            target: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export const WorkspaceDiskCallSchema = z
  .object({ session: WorkspaceSessionSchema, spec: z.unknown(), disk: DiskOpSchema })
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
    /**
     * The session's sandbox: the session, and the Environment whose sandbox it is. `spec` is the
     * sandbox spec the session pinned when it opened (`SandboxManifest`); absent, the session has
     * no sandbox, and a `sandbox` call fails.
     */
    sandbox: z
      .object({
        ownerId: id,
        environmentId: id.optional(),
        spec: z.unknown().optional(),
        /**
         * Variables every sandbox command gets (R2c, D50): each `environment_secret` name set to
         * the sentinel `nylorun_managed`, and each `environment_variable`'s value. Never a secret.
         */
        environment: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The fields of `TurnStart.checkpoint` a harness reads (R4.2); the rest are our engine's. An
 * agent turn's `input` is the turn's message: a string, `{text, metadata?}`, `{content,
 * metadata?}` with user content parts, `{kind: "messages", messages}` for messages that waited in
 * the session's queue (protocol 17: each one of the shapes before, each its own user message, in
 * order), `{kind: "continue"}` for the next segment of a yielded turn, or an approval or response
 * event. Effect ids are prefixed `<turnId>:<segment>:`
 * (`effectIdOf`), and every intent carries `manifestHash`. `state` is the harness's own, as its
 * last output left it: core stores it unread (at most `limits.harnessStateBytes` for a harness
 * other than ours) and folds the transcript every segment, whatever the state holds. A model
 * call's `executionId` is the session id.
 */
export const HarnessCheckpointSchema = z.looseObject({
  sessionId: id,
  turnId: id,
  segment: z.number().int().min(0),
  manifestHash: z.string(),
  input: z.unknown().optional(),
  state: z.unknown().optional(),
});

/** W3C trace context: `traceparent`, and `tracestate` when the trace carries one. */
export const TraceContextSchema = z
  .object({
    traceparent: z.string().regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    tracestate: z.string().max(512).optional(),
  })
  .strict();

/**
 * The model a turn's calls use when they name none (protocol 15): the Tenant's model, as the
 * Model Gate resolves it. `provider` and `id` name it (`fixture` for the fixture model); `inputs`
 * is what it reads, text first, in `MODEL_INPUTS` order (its catalog's inputs and the operator's
 * additions); `contextWindow` and `maxOutputTokens` are in tokens. A harness decides from it how
 * each file reaches the model; the gate refuses a part the model cannot take
 * (`unsupported_input`).
 */
export const ModelDescriptorSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    inputs: z.array(ModelInputSchema).min(1),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    reasoning: z.boolean().optional(),
  })
  .strict();

/**
 * The Agent a turn runs on (Harness API 5, protocol 16): its id and kind and, when it has a
 * sandbox, the workspace its commands start in. A harness writes the model's instructions and
 * defines its sandbox tools from it; the sandbox's spec is the routing's (`routing.sandbox.spec`).
 * The Agent's runtime section never reaches the harness.
 */
export const TurnAgentSchema = z
  .object({
    id,
    kind: z.enum(ENVIRONMENT_KINDS),
    /** Present when the session has a sandbox. */
    sandbox: z.object({ workspace: z.string().regex(/^\//) }).strict().optional(),
  })
  .strict();

/** What a run starts from: `turn.start` (message, continue, resume) or `approval.answer`. */
export const TurnStartSchema = z
  .object({
    type: z.enum(["turn.start", "approval.answer"]),
    engine: z.enum(["agent", "flow"]),
    /**
     * The turn's loop manifest: the harness section of the agent manifest version its session
     * pinned, with the manifest's name as its `id` (agent manifest v7's shape), or the workflow
     * manifest (flow). A flow's leaf session gets its embedded agent's.
     */
    manifest: document,
    /** The agent manifest version the session pinned (protocol 16), for the harness's records. */
    definition: z.object({ name: z.string(), version: z.number().int().positive() }).strict().optional(),
    /**
     * The harness section's `loop` (protocol 16): the harness's own settings, which the Runtime
     * passes on without reading. Ours reads none yet.
     */
    loop: document.optional(),
    /** The segment's checkpoint; an agent's state has no transcript (`transcript.cursor`). */
    checkpoint: document,
    /**
     * The session's MCP discovery as this turn sees it (protocol 15), once its first run recorded
     * it (`session.mcp`): each server of the agent tree that connected, its instructions and its
     * tools, raw, with whether the turn's manifest leaves each `enabled`. The harness names the
     * tools for the model and calls one by its target `{kind: "mcp", server, tool}`.
     */
    mcp: McpFactsSchema.optional(),
    /** Completed outcomes of this segment, resolved without asking core. */
    outcomes: z.array(RecordedOutcomeSchema).readonly(),
    /** The record position the session's transcript was folded at. */
    transcript: z.object({ cursor: z.number().int() }).strict(),
    options: z
      .object({
        yieldAfter: z.object({ steps: z.number().optional(), ms: z.number().optional() }).strict().optional(),
        flowLimits: z.unknown().optional(),
        /**
         * Informational: the Tenant answers model calls with the fixture model. The Model Gate
         * answers them itself (R4.3), so a harness calls the gate as for any model.
         */
        fixtureModel: z.boolean(),
      })
      .strict(),
    routing: RunRoutingSchema,
    /**
     * The turn's trace context (R4.10), when the Runtime traces: a harness may send it as
     * `traceparent` on its gate calls and as `TRACEPARENT` to the processes it starts, so its own
     * spans join the turn's trace. The Runtime never ingests a harness's spans.
     */
    trace: TraceContextSchema.optional(),
    /**
     * The Runtime limits in force when the segment started (the Tenant's, `PUT
     * /v1/tenant/limits`): what one record entry (an effect outcome, a claimed event, a transcript
     * update), model call, model file, tool answer, custom harness state, Harness API chunk and
     * folder artifact may hold. Past one, core refuses the request with `limit_exceeded`. Only
     * the limits a harness must respect (`HarnessLimitsSchema`); one it does not know is dropped.
     */
    limits: HarnessLimitsSchema,
    /**
     * The model the turn's calls use when they name none (protocol 15): what it reads and its
     * window, as the segment started. Absent for a flow, and when the Tenant has no model.
     */
    model: ModelDescriptorSchema.optional(),
    /**
     * The Agent the session runs on (Harness API 5; `environment` before): what our engine writes
     * the sandbox notes and defines the sandbox tools from. Absent for a flow.
     */
    agent: TurnAgentSchema.optional(),
  })
  .strict();

/**
 * A segment's end. `state` is the harness's state for the next segment (our engine's has no
 * transcript); `transcript` edits the transcript the segment started from. `thrown` reports an
 * engine that threw. The method follows the status: `completed` is `turn.completed`, `failed`
 * and `cancelled` are `turn.failed` (after a cancel, report `cancelled`), `waiting` and
 * `uncertain` are `turn.waiting` (an effect is pending or uncertain), `yielded` is `checkpoint`
 * (the turn goes on in a new segment), `paused` is `turn.paused` (our engine only, in v2). An
 * `execute` answer with `rejoin` re-sends a call its previous owner left running at a gate,
 * same key and body, to join it or collect its outcome.
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
  z
    .object({
      status: z.literal("execute"),
      rejoin: z.literal(true).optional(),
      /**
       * The call's span context (R7.4), for a tool call: a harness hands it on as `TRACEPARENT`
       * to the command it runs, so the command's own spans join the call's.
       */
      traceparent: TraceContextSchema.shape.traceparent.optional(),
    })
    .strict(),
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
   * `features.workspace` declares that the harness serves the Tenant's workspaces (F6.2):
   * core then sends it the `workspace.*` requests. The answer names the Tenant (its workspace
   * keys are scoped by it) and the sandbox backend preference the harness selects with.
   */
  hello: {
    params: z
      .object({
        api: z.number().int(),
        name: z.string(),
        version: z.string(),
        features: z.object({ workspace: z.unknown().optional() }).strict(),
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
        /** With `environment.state`: the workspace's compute record as it is now. */
        record: WorkspaceRecordSchema.optional(),
      })
      .strict(),
    result: empty,
  },
  "session.mcp": {
    params: runId.extend({ snapshot: McpSnapshotSchema.optional(), diagnostics: z.array(z.unknown()) }).strict(),
    result: z.object({ mcp: McpFactsSchema.optional() }).strict(),
  },
  /**
   * A definition file's bytes, base64 (track R2 M4): one the run's definition names, for the
   * skills its sandbox mounts. With `offset` and `length` (at most `turn.start.limits.chunkBytes`,
   * its default without `length`; more is `limit_exceeded`), only those bytes: fewer than
   * `length`, none past the end, once the file ends. Without them the whole file, which must then
   * fit one frame.
   */
  "definition.file": {
    params: runId
      .extend({
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().positive().max(RUNTIME_LIMIT_CEILINGS.chunkBytes.value).optional(),
      })
      .strict(),
    result: z.object({ base64: z.string() }).strict(),
  },
  /**
   * An artifact the run's session may read (the artifact seam, protocol 15): one of the session's
   * own, or a Tenant-wide one its messages named; anything else is `not_found`, alike. The answer
   * carries the version's metadata (`version`, default the latest) and its bytes from `offset`
   * (default 0), base64: at most `length`, which defaults to and is held to
   * `turn.start.limits.chunkBytes`; `length: 0` asks for the metadata alone. `eof` says no bytes
   * are left past this chunk. A folder answers its metadata, with no bytes.
   */
  "artifact.read": {
    params: runId
      .extend({
        artifactId: id,
        version: z.number().int().min(1).optional(),
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().nonnegative().optional(),
      })
      .strict(),
    result: z
      .object({
        artifact: ArtifactMetaSchema,
        offset: z.number().int().nonnegative(),
        base64: z.string(),
        eof: z.boolean(),
      })
      .strict(),
  },
  /**
   * Writes a file artifact of the run's session, or a new version of one of its own (the artifact
   * seam, protocol 15), streamed in chunks of at most `turn.start.limits.chunkBytes`:
   *
   * - `begin` opens an upload, answered `open` with its `uploadId` and the most bytes it may hold
   *   now (`maxBytes`: the file limit, or the room left in a total). `key` makes the write
   *   idempotent within the session: a key already written answers `written` with `created:
   *   false` and the version it wrote. With `base64`, the whole body comes in the `begin`, which
   *   then commits at once. `effectId` links the artifact to a tool call of the run's turn, whose
   *   call id its `artifact.created` event carries.
   * - `chunk` sends the bytes from `offset`, which must equal the bytes received so far; a repeat
   *   of the last chunk is answered as before.
   * - `commit` stores the version (`written`); `abort` drops the upload. An upload the run leaves
   *   open ends with the run.
   *
   * With `kind: "folder"`, `begin` opens a folder version instead: a new version of the session's
   * folder `artifactId`, or with `sameName` of its newest folder named `name` (made when there is
   * none), or else a new folder. Its answer adds `maxFileBytes` (one file's limit) and
   * `maxEntries` (`limits.folderEntries`); `maxBytes` is the most its files may hold together.
   * Each file starts with `file` (its path in the folder, size and SHA-256, the whole body in
   * `base64` when it fits one chunk), and goes on with `chunk`s naming it by `sha256`, from
   * `offset` within the file. Core always takes every byte, stored or not (it holds content once,
   * by hash), and refuses a file whose bytes do not match its hash (`invalid`; the upload ends).
   * `commit` answers `written` with `unchanged: true` and no new version when the files are the
   * folder's latest version's, and `refused` when a total would be passed.
   */
  "artifact.write": {
    params: z.union([
      runId
        .extend({
          op: z.literal("begin"),
          key: id,
          artifactId: id.optional(),
          name: z.string().min(1).max(ARTIFACT_NAME_MAX).optional(),
          contentType: z.string().min(1).optional(),
          size: z.number().int().nonnegative().optional(),
          effectId: id.optional(),
          base64: z.string().optional(),
        })
        .strict(),
      runId
        .extend({
          op: z.literal("begin"),
          kind: z.literal("folder"),
          key: id,
          name: z.string().min(1).max(ARTIFACT_NAME_MAX),
          artifactId: id.optional(),
          sameName: z.literal(true).optional(),
        })
        .strict(),
      runId
        .extend({
          op: z.literal("file"),
          uploadId: id,
          path: z.string().min(1),
          size: z.number().int().nonnegative(),
          sha256: hex64,
          contentType: z.string().min(1).optional(),
          base64: z.string().optional(),
        })
        .strict(),
      runId
        .extend({
          op: z.literal("chunk"),
          uploadId: id,
          /** A folder upload's file this chunk continues. */
          sha256: hex64.optional(),
          offset: z.number().int().nonnegative(),
          base64: z.string().min(1),
        })
        .strict(),
      runId.extend({ op: z.literal("commit"), uploadId: id }).strict(),
      runId.extend({ op: z.literal("abort"), uploadId: id }).strict(),
    ]),
    result: z.union([
      z
        .object({
          status: z.literal("open"),
          uploadId: id,
          maxBytes: z.number().int().nonnegative(),
          /** A folder upload: one file's limit, and the most files it may hold. */
          maxFileBytes: z.number().int().nonnegative().optional(),
          maxEntries: z.number().int().positive().optional(),
          /** Bytes received: of the upload, or of a folder upload's file in progress. */
          received: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          status: z.literal("written"),
          artifact: ArtifactMetaSchema,
          created: z.boolean(),
          /** A folder whose files are its latest version's: no version was added. */
          unchanged: z.literal(true).optional(),
        })
        .strict(),
      z
        .object({
          status: z.literal("refused"),
          /** The total a folder version would pass: the Tenant's, or the session's Environment's. */
          reason: z.enum(["tenant_total", "environment_total"]),
          message: z.string(),
          limit: z.number().int().nonnegative(),
        })
        .strict(),
      z.object({ status: z.literal("aborted") }).strict(),
    ]),
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
 * sandbox tool's answer is its `SandboxToolOutcome`; the harness claims its `environment.*` events
 * while the request is in flight.
 */
export const coreRequests = {
  "workspace.read": {
    params: z.union([WorkspaceCallSchema, WorkspaceDiskCallSchema]),
    result: outcomeObject,
  },
  "workspace.write": { params: z.union([WorkspaceCallSchema, WorkspaceDiskCallSchema]), result: outcomeObject },
  "workspace.exec": { params: WorkspaceCallSchema, result: outcomeObject },
  /** The harness's sandbox selection report (`GET /v1/tenant/sandbox`, Tenant status). */
  "workspace.report": { params: empty, result: outcomeObject },
  /** Stops idle workspaces, then lists every workspace the harness keeps. */
  "workspace.sweep": {
    params: z.object({ now: z.number().optional() }).strict(),
    result: z.object({ workspaces: z.array(WorkspaceRecordSchema) }).strict(),
  },
  /** Deletes workspaces with their files: by key, by Environment, or all of them. */
  "workspace.remove": {
    params: z
      .object({
        keys: z.array(z.string().min(1)).optional(),
        environmentIds: z.array(id).optional(),
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
