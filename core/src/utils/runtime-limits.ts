/**
 * Runtime limits: the sizes, counts and deadlines the Runtime holds
 * what crosses it to, one Tenant setting (`limits.config`, `GET`/`PUT /v1/tenant/limits`) with a
 * default each. A harness learns the ones it must respect from `turn.start.limits`
 * (`HarnessLimitsSchema`, a part of them).
 *
 * A limit is configuration; what the Runtime depends on is not. Each limit has a ceiling taken
 * from a dependency (S2's largest record, the Harness API's largest WebSocket frame, the longest
 * string the JavaScript engine makes, the longest timer it sets, the largest integer a JavaScript
 * number holds exactly), and a setting above its ceiling is refused when it is put
 * (`runtimeLimitIssues`).
 */
import { z } from "zod";
import { HARNESS_MAX_PAYLOAD } from "../harness-api/transport.js";

/**
 * S2's largest record: 1 MiB, metered as 8 bytes, plus its headers, plus its body. The stream
 * relay writes each event's JSON as one record's body, with no headers.
 */
export const S2_RECORD_MAX_BYTES = 1024 * 1024;

/**
 * Room an event's envelope takes beside its payload: ids, cursor, time, writer and principal
 * come to about 1 KiB; 64 KiB leaves them ample room under `S2_RECORD_MAX_BYTES`.
 */
export const RECORD_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * The longest string V8 makes on 64-bit (`String::kMaxLength`, 2^29 - 24 code units): a JSON
 * body the Runtime reads whole, or a file it sends a provider in base64, is one such string.
 */
export const JS_STRING_MAX_LENGTH = 2 ** 29 - 24;

/**
 * The longest delay a JavaScript timer takes (`setTimeout`, `setInterval`, `AbortSignal.timeout`):
 * a signed 32-bit count of milliseconds, about 24.8 days. A longer one fires at once.
 */
export const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * The longest single argument Linux passes to a program (`MAX_ARG_STRLEN`, 32 pages of 4 KiB),
 * its terminating NUL included: a setup command is one argument of `/bin/sh -c`.
 */
export const LINUX_ARG_MAX_BYTES = 32 * 4096;
/** The longest setup command that fits it: UTF-8 takes at most 3 bytes for one UTF-16 code unit. */
const SETUP_COMMAND_MAX_CHARS = Math.floor((LINUX_ARG_MAX_BYTES - 1) / 3);

/** The most bytes base64 of `length` characters decodes to: groups of 4 characters, 3 bytes each. */
const base64Bytes = (length: number) => Math.floor(length / 4) * 3;

/** The fewest characters one item of a JSON list or map takes: its JSON and the comma after it. */
const minChars = (item: unknown) => JSON.stringify(item).length + 1;

/**
 * The fewest characters one entry of a folder's manifest takes as JSON: an entry with a
 * one-character path and type. A folder's manifest is read as one string, so it holds at most
 * `JS_STRING_MAX_LENGTH` of them.
 */
const FOLDER_ENTRY_MIN_CHARS = minChars({ path: "a", size: 0, sha256: "0".repeat(64), contentType: "a" });

/** The fewest characters one entry of a disk listing takes as JSON (`DiskOp` `list`). */
const DISK_ENTRY_MIN_CHARS = minChars({ path: "a", type: "dir", mode: 0 });

/** The most bytes JSON escapes one character of a quoted text to: a control character, `\u0000`. */
const JSON_ESCAPE_MAX_BYTES = 6;

/**
 * The limits a harness must respect, sent in `turn.start.limits`:
 *
 * - `recordEntryBytes`: the most JSON one entry of the record may hold: an event's payload (a
 *   harness's claimed event, a transcript update, core's own), and an effect outcome a harness
 *   reports. Past it the write is refused with `limit_exceeded`. A transcript edit fills events up
 *   to it (`transcriptUpdates`).
 * - `modelCallBytes`: the largest model call body the Model Gate reads.
 * - `modelFileBytes`: the largest file (an image, a text file) the Model Gate sends a model.
 * - `toolAnswerBytes`: the largest answer the Tool Gate keeps of an MCP or HTTP tool
 *   (`mcp.too-large`, `http.too-large` past it), and the largest tool call body it reads.
 * - `harnessStateBytes`: the most state a custom harness may keep per session, as JSON.
 * - `chunkBytes`: the most bytes one chunked Harness API answer carries (`definition.file` and
 *   `artifact.read` with a range, a disk read).
 * - `folderEntries`: the most files one folder artifact a harness writes may hold
 *   (`artifact.write` with `kind: "folder"`, such as our engine's outputs folder).
 */
const harnessLimits = {
  recordEntryBytes: z.number().int().positive(),
  modelCallBytes: z.number().int().positive(),
  modelFileBytes: z.number().int().positive(),
  toolAnswerBytes: z.number().int().positive(),
  harnessStateBytes: z.number().int().positive(),
  chunkBytes: z.number().int().positive(),
  folderEntries: z.number().int().positive(),
};

/**
 * The Runtime limits: the harness's (above), and the ones only the Runtime checks, by area.
 *
 * Requests and uploads:
 * - `requestBodyBytes`: the largest JSON body a Runtime or Management API route reads.
 * - `messageParts`: the most parts one user message carries (text and files).
 * - `pageItems`: the most items one page of a listing holds (`limit`), and `exportPageItems` one
 *   page of the model call export (`GET /v1/tenant/calls/model`). A page asked for with no
 *   `limit` holds the route's default, or this limit when it is lower; one asking more holds this
 *   many. `environmentEventItems`: the most events one read of an Environment's events returns.
 * - `inlineFileBytes`: the largest file a message carries inline, decoded (AG-UI, A2A). Such an
 *   endpoint reads a body of one file at this size in base64 and `requestBodyBytes` more
 *   (`inlineBodyBytes`).
 * - `a2aWaitMs`: how long a blocking A2A `SendMessage` waits for its task to end or ask for input.
 * - `errorExcerptChars`: how much of a failed MCP server's or HTTP tool's answer an error quotes.
 * - `traceContentBytes`: the most UTF-8 bytes of one content attribute of an exported span.
 *
 * Labels (an Environment's and an artifact's, checked whenever they are set):
 * - `environmentLabels`, `artifactLabels`: the most labels one Environment, and one artifact,
 *   carries.
 * - `labelKeyChars`, `labelValueChars`: the longest label key, and value.
 *
 * Environments (checked when one is made):
 * - `environmentSetupCommands`, `environmentFiles`: the most setup commands, and input file
 *   entries, one manifest holds.
 * - `environmentFilesPerEntry`: the most files one input file entry by hash names.
 * - `environmentSecretSlots`: the most secret slots one manifest declares.
 * - `setupCommandChars`: the longest setup command.
 * - `setupCommandMs`: the longest `timeout` one setup command may ask for (a command's default is
 *   10 minutes).
 * - `setupOutputChars`: how much of a failed setup command's output its event keeps.
 * - `setupReasonChars`, `setupCommandExcerptChars`: how much of the end of that output, and of
 *   the start of the command, a failed pod's reason quotes.
 * - `manifestDescriptionChars`, `secretDescriptionChars`: the longest description of an
 *   environment manifest, and of one of its secret slots.
 *
 * Secrets (checked when one is written, and a manifest's slots when it is put):
 * - `secretValueChars`: the longest value of an `environment_secret` or `environment_variable`.
 * - `secretHosts`: the most hosts one `environment_secret` may be sent to (`allowedHosts`).
 *
 * Disk versions:
 * - `diskVersionEntries`, `diskVersionBytes`: the most entries, and bytes of files, one version
 *   of an Environment's disk holds (an Environment's manifest may set less: `limits.disk`).
 * - `diskLeaseMs`: how long a disk copy's lease lasts unrenewed; the copy renews it every quarter
 *   of it, and a copy whose process died is taken over once it lapses.
 * - `diskPodWaitMs`: how long a disk copy waits for a pod's engine to connect.
 *
 * Model calls (the Model Gate's provider calls):
 * - `modelRequestMs`: the longest one provider request may take.
 * - `modelIdleMs`: how long a provider's stream may go without an event before the attempt is
 *   abandoned and tried again.
 * - `modelAttempts`: the attempts one call makes, the first included.
 * - `modelRetryDelayMs`: the delay before the second attempt; it doubles each time, with jitter.
 * - `modelProviderRetries`, `modelRetryDelayMaxMs`: the retries the provider's SDK makes within
 *   one attempt, and the longest delay it waits before one.
 *
 * Tools:
 * - `toolAttempts`: how many times an MCP or HTTP tool call is sent, across crashes and lost
 *   hops, before it fails to the model as `tool.interrupted`.
 * - `httpToolTimeoutMs`: the longest `timeoutMs` an HTTP tool may ask for (a tool's default is
 *   60 s), checked when an agent is deployed and when the tool is called.
 * - `mcpSnapshotBytes`: the most JSON a session pins of what its MCP servers said at discovery
 *   (tools with their schemas, instructions), which every `turn.start.mcp` carries. A server that
 *   does not fit is left out, with a diagnostic.
 * - `mcpPreviewMs`: how long an MCP preview may take, `initialize` and every `tools/list` page.
 * - `mcpMetadataBytes`: the largest protected-resource metadata document a preview reads.
 * - `toolRules`: the most rules the Tenant's tool policy holds; `toolRuleFieldChars` the longest
 *   selector (`tool`, `server`, `agent`) or `when` path of one, and `toolRuleTextChars` the
 *   longest `reason` or `matches` expression.
 * - `modelBudgets`: the most model budgets the Tenant sets.
 *
 * Triggers (checked when a manifest is saved, and when a trigger fires):
 * - `triggersPerAgent`: the most triggers one agent manifest declares.
 * - `triggerMinIntervalMs`: the shortest gap between two runs of one schedule (cron is minute
 *   grained, so at least a minute), checked over its next fires at save.
 * - `triggerRunsPerHour`: the most runs one Agent's triggers start or queue in any hour; later
 *   ones are skipped (`rate_limited`). The guard against an Agent triggering itself.
 * - `triggerJitterPercent`, `triggerJitterMaxMs`: how far each schedule's fixed offset may move
 *   its runs, as a part of its interval and at most.
 * - `triggerPromptChars`: the longest prompt one trigger holds.
 * - `triggerRunRetentionMs`: how long runs are kept; they dedupe repeated fires, so at least a day.
 * - `wakeMaxAheadMs`: how far ahead `schedule_wake` may book a session's next turn; at least
 *   `triggerMinIntervalMs` ahead too. A long wait is armed in steps, so it has no timer ceiling.
 * - `wakeNoteChars`: the longest note a booked wake carries to its turn.
 * - `webhookBodyBytes`: the largest delivery a webhook endpoint reads, before it verifies it
 *   (`413` past it); the payload goes into the turn's message, one record entry.
 *
 * Memory (checked on every write):
 * - `memoryBytes`: the largest memory, in UTF-8 bytes.
 * - `memoriesPerAgent`: the most memories one Agent holds.
 * - `memoryIndexLines`, `memoryIndexBytes`: the most lines and UTF-8 bytes of the index a session
 *   pins at its start (`turn.start.memory.index`); the newest memories come first.
 *
 * Sessions:
 * - `sessionQueuedMessages`: the most messages one session's queue holds while its turn runs or
 *   waits (protocol 17); one more is `429 queue_full`.
 *
 * Flows (`workflows.md` §13):
 * - `flowConcurrency`: the most effects one flow turn runs at once; the rest wait their turn.
 * - `flowMapItems`: the most items one map stage may fan out to (`map.too-many-items` past it).
 * - `flowLoopIterations`: the most iterations one loop stage runs (`loop.too-many-iterations`).
 *
 * Agent folders (track T7, checked when a folder is saved, and by the compiler):
 * - `folderFiles`: the most files one agent folder holds.
 * - `folderBytes`: the most bytes its files hold together.
 * - `folderTextFileBytes`: the largest Markdown or JSON file of a folder the compiler reads.
 */
export const RuntimeLimitsSchema = z
  .object({
    ...harnessLimits,
    requestBodyBytes: z.number().int().positive(),
    messageParts: z.number().int().positive(),
    pageItems: z.number().int().positive(),
    exportPageItems: z.number().int().positive(),
    environmentEventItems: z.number().int().positive(),
    inlineFileBytes: z.number().int().positive(),
    a2aWaitMs: z.number().int().positive(),
    errorExcerptChars: z.number().int().positive(),
    traceContentBytes: z.number().int().positive(),
    environmentLabels: z.number().int().positive(),
    artifactLabels: z.number().int().positive(),
    labelKeyChars: z.number().int().positive(),
    labelValueChars: z.number().int().positive(),
    environmentSetupCommands: z.number().int().positive(),
    environmentFiles: z.number().int().positive(),
    environmentFilesPerEntry: z.number().int().positive(),
    environmentSecretSlots: z.number().int().positive(),
    setupCommandChars: z.number().int().positive(),
    setupCommandMs: z.number().int().positive(),
    setupOutputChars: z.number().int().positive(),
    setupReasonChars: z.number().int().positive(),
    setupCommandExcerptChars: z.number().int().positive(),
    manifestDescriptionChars: z.number().int().positive(),
    secretDescriptionChars: z.number().int().positive(),
    secretValueChars: z.number().int().positive(),
    secretHosts: z.number().int().positive(),
    diskVersionEntries: z.number().int().positive(),
    diskVersionBytes: z.number().int().positive(),
    diskLeaseMs: z.number().int().positive(),
    diskPodWaitMs: z.number().int().positive(),
    modelRequestMs: z.number().int().positive(),
    modelIdleMs: z.number().int().positive(),
    modelAttempts: z.number().int().positive(),
    modelRetryDelayMs: z.number().int().positive(),
    modelProviderRetries: z.number().int().nonnegative(),
    modelRetryDelayMaxMs: z.number().int().positive(),
    toolAttempts: z.number().int().positive(),
    httpToolTimeoutMs: z.number().int().positive(),
    mcpSnapshotBytes: z.number().int().positive(),
    mcpPreviewMs: z.number().int().positive(),
    mcpMetadataBytes: z.number().int().positive(),
    toolRules: z.number().int().positive(),
    toolRuleFieldChars: z.number().int().positive(),
    toolRuleTextChars: z.number().int().positive(),
    modelBudgets: z.number().int().positive(),
    triggersPerAgent: z.number().int().positive(),
    triggerMinIntervalMs: z.number().int().positive(),
    triggerRunsPerHour: z.number().int().positive(),
    triggerJitterPercent: z.number().int().nonnegative(),
    triggerJitterMaxMs: z.number().int().nonnegative(),
    triggerPromptChars: z.number().int().positive(),
    triggerRunRetentionMs: z.number().int().positive(),
    webhookBodyBytes: z.number().int().positive(),
    wakeMaxAheadMs: z.number().int().positive(),
    wakeNoteChars: z.number().int().positive(),
    memoryBytes: z.number().int().positive(),
    memoriesPerAgent: z.number().int().positive(),
    memoryIndexLines: z.number().int().positive(),
    memoryIndexBytes: z.number().int().positive(),
    sessionQueuedMessages: z.number().int().positive(),
    flowConcurrency: z.number().int().positive(),
    flowMapItems: z.number().int().positive(),
    flowLoopIterations: z.number().int().positive(),
    folderFiles: z.number().int().positive(),
    folderBytes: z.number().int().positive(),
    folderTextFileBytes: z.number().int().positive(),
  })
  .strict();
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;
export type RuntimeLimit = keyof RuntimeLimits;

/**
 * The Runtime limits a harness must respect (`turn.start.limits`). A limit the Runtime adds later
 * that a harness does not know is dropped when it parses them.
 */
export const HarnessLimitsSchema = z.object(harnessLimits);
export type HarnessLimits = z.infer<typeof HarnessLimitsSchema>;
export type HarnessLimit = keyof HarnessLimits;
const HARNESS_LIMIT_NAMES = Object.keys(harnessLimits) as HarnessLimit[];

/** The part of `limits` a harness is sent. */
export function harnessLimitsOf(limits: RuntimeLimits): HarnessLimits {
  return Object.fromEntries(HARNESS_LIMIT_NAMES.map((name) => [name, limits[name]])) as HarnessLimits;
}

/** What a limit counts. */
export type RuntimeLimitUnit =
  | "percent"
  | "runs"
  | "bytes"
  | "entries"
  | "characters"
  | "milliseconds"
  | "attempts"
  | "retries"
  | "effects"
  | "iterations";

interface Ceiling {
  readonly value: number;
  readonly unit: RuntimeLimitUnit;
  readonly why: string;
}

const recordEntryCeiling = S2_RECORD_MAX_BYTES - RECORD_ENVELOPE_RESERVE_BYTES;
/** A time a JavaScript timer waits. */
const timer = (what: string): Ceiling => ({
  value: TIMER_MAX_MS,
  unit: "milliseconds",
  why: `${what} with a JavaScript timer, which waits at most ${TIMER_MAX_MS} ms`,
});
/** A number the Runtime counts or adds up, with no other bound. */
const counted = (unit: RuntimeLimitUnit, what: string): Ceiling => ({
  value: Number.MAX_SAFE_INTEGER,
  unit,
  why: `${what} in a JavaScript number, exact up to ${Number.MAX_SAFE_INTEGER}`,
});
/** A count of items one request carries, which is read as one string. */
const inRequest = (what: string, item: unknown): Ceiling => {
  const chars = minChars(item);
  return {
    value: Math.floor(JS_STRING_MAX_LENGTH / chars),
    unit: "entries",
    why: `${what} arrive in one request body, read as one string of at most ${JS_STRING_MAX_LENGTH} characters, and each takes at least ${chars}`,
  };
};
/** A count of items one answer carries, which is written as one string. */
const inAnswer = (what: string, item: unknown): Ceiling => {
  const chars = minChars(item);
  return {
    value: Math.floor(JS_STRING_MAX_LENGTH / chars),
    unit: "entries",
    why: `${what} go in one response body, written as one string of at most ${JS_STRING_MAX_LENGTH} characters, and each takes at least ${chars}`,
  };
};
/** A text one request carries. */
const inRequestText = (what: string): Ceiling => ({
  value: JS_STRING_MAX_LENGTH,
  unit: "characters",
  why: `${what} arrives in one request body, read as one string of at most ${JS_STRING_MAX_LENGTH} characters`,
});
/** A text quoted in one record entry, as JSON. */
const quoted = (what: string): Ceiling => ({
  value: Math.floor(recordEntryCeiling / JSON_ESCAPE_MAX_BYTES),
  unit: "characters",
  why: `${what} is kept in one record entry (at most ${recordEntryCeiling} bytes), where JSON may escape a character to ${JSON_ESCAPE_MAX_BYTES}`,
});

/**
 * Each limit's ceiling, which no setting may pass, what it counts, and the dependency it comes
 * from.
 */
export const RUNTIME_LIMIT_CEILINGS: { readonly [K in RuntimeLimit]: Ceiling } = {
  recordEntryBytes: {
    value: recordEntryCeiling,
    unit: "bytes",
    why: `S2 takes records of at most ${S2_RECORD_MAX_BYTES} bytes, and an event's envelope needs ${RECORD_ENVELOPE_RESERVE_BYTES} beside its payload`,
  },
  modelCallBytes: {
    value: JS_STRING_MAX_LENGTH,
    unit: "bytes",
    why: `the Model Gate reads a call's body as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  modelFileBytes: {
    value: base64Bytes(JS_STRING_MAX_LENGTH),
    unit: "bytes",
    why: `a file goes to the provider as one base64 string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  toolAnswerBytes: {
    value: HARNESS_MAX_PAYLOAD / 2,
    unit: "bytes",
    why: `a harness reports the answer to core in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), as JSON, whose escapes may double it`,
  },
  harnessStateBytes: {
    value: HARNESS_MAX_PAYLOAD / 2,
    unit: "bytes",
    why: `the state crosses in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes) with the rest of its output or turn.start`,
  },
  chunkBytes: {
    value: base64Bytes(HARNESS_MAX_PAYLOAD) - RECORD_ENVELOPE_RESERVE_BYTES,
    unit: "bytes",
    why: `a chunk crosses in base64 in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), with room for the frame's own JSON`,
  },
  folderEntries: {
    value: Math.floor(JS_STRING_MAX_LENGTH / FOLDER_ENTRY_MIN_CHARS),
    unit: "entries",
    why: `a folder's manifest is read as one string, of at most ${JS_STRING_MAX_LENGTH} characters, and each entry takes at least ${FOLDER_ENTRY_MIN_CHARS}`,
  },
  requestBodyBytes: {
    value: JS_STRING_MAX_LENGTH,
    unit: "bytes",
    why: `a body is read as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  messageParts: inRequest("parts", { type: "text", text: "a" }),
  pageItems: inAnswer("a page's items", {}),
  exportPageItems: inAnswer("a page's calls", {}),
  environmentEventItems: inAnswer("the events", {}),
  inlineFileBytes: {
    value: base64Bytes(JS_STRING_MAX_LENGTH),
    unit: "bytes",
    why: `a file sent inline arrives in base64 in a body read as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  a2aWaitMs: timer("the wait is timed"),
  errorExcerptChars: quoted("the excerpt"),
  traceContentBytes: {
    value: recordEntryCeiling,
    unit: "bytes",
    why: `span content is cut from one record entry, which holds at most ${recordEntryCeiling} bytes`,
  },
  environmentLabels: inRequest("labels", { a: "" }),
  artifactLabels: inRequest("labels", { a: "" }),
  labelKeyChars: inRequestText("a label key"),
  labelValueChars: inRequestText("a label value"),
  environmentSetupCommands: inRequest("setup commands", { command: "a" }),
  environmentFiles: inRequest("input file entries", { path: "/workspace", files: {} }),
  environmentFilesPerEntry: inRequest("the files of an entry", { a: `sha256:${"0".repeat(64)}` }),
  environmentSecretSlots: inRequest("secret slots", { A: { type: "environment_variable" } }),
  setupCommandChars: {
    value: SETUP_COMMAND_MAX_CHARS,
    unit: "characters",
    why: `a command runs as one argument of /bin/sh -c, which Linux takes up to ${LINUX_ARG_MAX_BYTES} bytes long (MAX_ARG_STRLEN, with its NUL), and UTF-8 may take 3 bytes for a character`,
  },
  setupCommandMs: timer("the engine times a command"),
  setupOutputChars: quoted("the output"),
  setupReasonChars: quoted("the reason"),
  setupCommandExcerptChars: quoted("the reason"),
  manifestDescriptionChars: inRequestText("a description"),
  secretDescriptionChars: inRequestText("a description"),
  secretValueChars: inRequestText("a value"),
  secretHosts: inRequest("hosts", "a.b"),
  diskVersionEntries: {
    value: Math.min(
      Math.floor(JS_STRING_MAX_LENGTH / FOLDER_ENTRY_MIN_CHARS),
      Math.floor(HARNESS_MAX_PAYLOAD / DISK_ENTRY_MIN_CHARS),
    ),
    unit: "entries",
    why: `a disk is listed in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes, each entry at least ${DISK_ENTRY_MIN_CHARS}), and a version's manifest is read as one string of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  diskVersionBytes: counted("bytes", "the files' sizes are added up"),
  diskLeaseMs: timer("the lease is renewed"),
  diskPodWaitMs: counted("milliseconds", "the deadline is reckoned from the clock"),
  modelRequestMs: timer("the provider's SDK times the request"),
  modelIdleMs: timer("the stream's silence is timed"),
  modelAttempts: counted("attempts", "attempts are counted"),
  modelRetryDelayMs: timer("the delay is waited"),
  modelProviderRetries: counted("retries", "retries are counted"),
  modelRetryDelayMaxMs: timer("the delay is waited"),
  toolAttempts: counted("attempts", "sends are counted"),
  httpToolTimeoutMs: timer("the call is timed"),
  mcpSnapshotBytes: {
    value: HARNESS_MAX_PAYLOAD / 4,
    unit: "bytes",
    why: `the facts cross in turn.start, one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), beside the harness's state (at most half of it) and the rest`,
  },
  mcpPreviewMs: timer("the preview is timed"),
  mcpMetadataBytes: {
    value: JS_STRING_MAX_LENGTH,
    unit: "bytes",
    why: `the document is read as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
  toolRules: inRequest("rules", { effect: "allow" }),
  toolRuleFieldChars: inRequestText("a selector"),
  toolRuleTextChars: inRequestText("a text"),
  modelBudgets: inRequest("budgets", { scope: "tenant" }),
  triggersPerAgent: inRequest("triggers", { a: { at: "2026-01-01T00:00:00Z", session: "a", prompt: "a" } }),
  triggerMinIntervalMs: counted("milliseconds", "the gap is reckoned from the clock"),
  triggerRunsPerHour: counted("runs", "runs are counted"),
  triggerJitterPercent: {
    value: 50,
    unit: "percent",
    why: "an offset past half the interval could move a run past the next one",
  },
  triggerJitterMaxMs: timer("the offset is waited"),
  triggerPromptChars: quoted("the prompt"),
  triggerRunRetentionMs: counted("milliseconds", "the age is reckoned from the clock"),
  wakeMaxAheadMs: counted("milliseconds", "the time is reckoned from the clock"),
  wakeNoteChars: quoted("the note"),
  memoryBytes: {
    value: HARNESS_MAX_PAYLOAD / 2,
    unit: "bytes",
    why: `a memory reaches a harness in one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), as JSON, whose escapes may double it`,
  },
  memoriesPerAgent: counted("entries", "memories are counted"),
  memoryIndexLines: counted("entries", "the lines are counted"),
  memoryIndexBytes: {
    value: HARNESS_MAX_PAYLOAD / 4,
    unit: "bytes",
    why: `the index crosses in turn.start, one Harness API frame (${HARNESS_MAX_PAYLOAD} bytes), beside the harness's state and the rest`,
  },
  webhookBodyBytes: {
    value: recordEntryCeiling,
    unit: "bytes",
    why: `the payload goes into one record entry, which holds at most ${recordEntryCeiling} bytes`,
  },
  sessionQueuedMessages: counted("entries", "queued messages are counted"),
  flowConcurrency: counted("effects", "running effects are counted"),
  flowMapItems: counted("entries", "items are counted"),
  flowLoopIterations: counted("iterations", "iterations are counted"),
  folderFiles: inRequest("a folder's files", { path: "a", size: 0, sha256: "0".repeat(64) }),
  folderBytes: counted("bytes", "the files' sizes are added up"),
  folderTextFileBytes: {
    value: JS_STRING_MAX_LENGTH,
    unit: "bytes",
    why: `the compiler reads a file as one string, of at most ${JS_STRING_MAX_LENGTH} characters`,
  },
};

/**
 * The limits a Tenant that sets none runs with: today's sizes and times. `recordEntryBytes` is
 * its ceiling, so every event S2 took before is still taken; what keeps a step's tool results
 * well inside it is the harness's shaping of them (Nylorun's engine: 256 KiB a step,
 * `shapeToolOutcome` in `@nylorun/harness`), since the record refuses an entry past it.
 */
export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = Object.freeze({
  recordEntryBytes: RUNTIME_LIMIT_CEILINGS.recordEntryBytes.value,
  modelCallBytes: 32 * 1024 * 1024,
  modelFileBytes: 8 * 1024 * 1024,
  toolAnswerBytes: 8 * 1024 * 1024,
  harnessStateBytes: 256 * 1024,
  chunkBytes: 16 * 1024 * 1024,
  folderEntries: 10_000,
  requestBodyBytes: 1024 * 1024,
  messageParts: 32,
  pageItems: 200,
  exportPageItems: 1_000,
  environmentEventItems: 1_000,
  inlineFileBytes: 20 * 1024 * 1024,
  a2aWaitMs: 5 * 60_000,
  errorExcerptChars: 2_000,
  traceContentBytes: 8 * 1024,
  environmentLabels: 32,
  artifactLabels: 32,
  labelKeyChars: 63,
  labelValueChars: 256,
  environmentSetupCommands: 16,
  environmentFiles: 16,
  environmentFilesPerEntry: 1_000,
  environmentSecretSlots: 64,
  setupCommandChars: 4_096,
  setupCommandMs: 30 * 60_000,
  setupOutputChars: 4 * 1024,
  setupReasonChars: 500,
  setupCommandExcerptChars: 80,
  manifestDescriptionChars: 1_024,
  secretDescriptionChars: 500,
  secretValueChars: 8_192,
  secretHosts: 32,
  diskVersionEntries: 200_000,
  diskVersionBytes: 10 * 1024 ** 3,
  diskLeaseMs: 2 * 60_000,
  diskPodWaitMs: 60_000,
  modelRequestMs: 600_000,
  modelIdleMs: 300_000,
  modelAttempts: 3,
  modelRetryDelayMs: 2_000,
  modelProviderRetries: 2,
  modelRetryDelayMaxMs: 60_000,
  toolAttempts: 3,
  httpToolTimeoutMs: 300_000,
  mcpSnapshotBytes: 4 * 1024 * 1024,
  mcpPreviewMs: 15_000,
  mcpMetadataBytes: 64 * 1024,
  toolRules: 200,
  toolRuleFieldChars: 200,
  toolRuleTextChars: 500,
  modelBudgets: 100,
  triggersPerAgent: 20,
  triggerMinIntervalMs: 60_000,
  triggerRunsPerHour: 60,
  triggerJitterPercent: 10,
  triggerJitterMaxMs: 300_000,
  triggerPromptChars: 8_000,
  triggerRunRetentionMs: 30 * 24 * 3_600_000,
  webhookBodyBytes: 256 * 1024,
  wakeMaxAheadMs: 30 * 24 * 3_600_000,
  wakeNoteChars: 2_000,
  memoryBytes: 100 * 1024,
  memoriesPerAgent: 10_000,
  memoryIndexLines: 200,
  memoryIndexBytes: 25 * 1024,
  sessionQueuedMessages: 100,
  flowConcurrency: 8,
  flowMapItems: 1_000,
  flowLoopIterations: 100,
  // T6's fixed values (`AGENT_FOLDER_LIMITS` in `@nylorun/core/folder`).
  folderFiles: 2_000,
  folderBytes: 50 * 1024 * 1024,
  folderTextFileBytes: 1024 * 1024,
});

/** The Runtime limits a harness gets when the Tenant sets none. */
export const HARNESS_LIMIT_DEFAULTS: HarnessLimits = Object.freeze(harnessLimitsOf(RUNTIME_LIMIT_DEFAULTS));

/** The limits in force: `set`, with the default for each it leaves out. */
export function runtimeLimitsOf(set: Partial<RuntimeLimits> | undefined): RuntimeLimits {
  const limits = { ...RUNTIME_LIMIT_DEFAULTS };
  for (const name of Object.keys(limits) as RuntimeLimit[]) {
    const value = set?.[name];
    if (value !== undefined) limits[name] = value;
  }
  return limits;
}

/**
 * Limits with a floor, which no setting may go under, and why: a schedule's cron is minute
 * grained, and runs dedupe repeated fires for as long as the execution's own dedupe lasts (a day).
 */
export const RUNTIME_LIMIT_FLOORS: { readonly [K in RuntimeLimit]?: { readonly value: number; readonly why: string } } = {
  triggerMinIntervalMs: { value: 60_000, why: "cron fires at most once a minute" },
  triggerRunRetentionMs: {
    value: 24 * 3_600_000,
    why: "a run row dedupes a repeated fire or delivery, which Durable Session Execution may send again for a day",
  },
};

/** Why `set` cannot be put: each limit above its ceiling or under its floor, naming why. */
export function runtimeLimitIssues(set: Partial<RuntimeLimits> | undefined): string[] {
  const issues: string[] = [];
  for (const [name, floor] of Object.entries(RUNTIME_LIMIT_FLOORS) as [RuntimeLimit, { value: number; why: string }][]) {
    const asked = set?.[name];
    if (asked !== undefined && asked < floor.value)
      issues.push(`limits.${name} asks for ${asked}; its floor is ${floor.value}: ${floor.why}.`);
  }
  for (const name of Object.keys(RUNTIME_LIMIT_CEILINGS) as RuntimeLimit[]) {
    const asked = set?.[name];
    const ceiling = RUNTIME_LIMIT_CEILINGS[name];
    if (asked !== undefined && asked > ceiling.value)
      issues.push(
        `limits.${name} asks for ${asked} ${ceiling.unit}; its ceiling is ${ceiling.value}: ${ceiling.why}.`,
      );
  }
  return issues;
}

/**
 * The message of a write refused for passing limit `name`: what was sent, the limit, and where an
 * operator sets it.
 */
export function limitExceededMessage(what: string, amount: number, name: RuntimeLimit, limit: number): string {
  const unit = RUNTIME_LIMIT_CEILINGS[name].unit;
  return `${what} is ${amount} ${unit}, over the Runtime limit ${name} (${limit} ${unit}; PUT /v1/tenant/limits).`;
}

/**
 * The body an endpoint that takes files inline reads (AG-UI, A2A): one file at `inlineFileBytes`
 * in base64 (a third larger), and `requestBodyBytes` for the rest of the request; never more
 * than one string holds.
 */
export function inlineBodyBytes(limits: Pick<RuntimeLimits, "inlineFileBytes" | "requestBodyBytes">): number {
  return Math.min(JS_STRING_MAX_LENGTH, Math.ceil(limits.inlineFileBytes / 3) * 4 + limits.requestBodyBytes);
}
