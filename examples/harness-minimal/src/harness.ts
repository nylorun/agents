/**
 * A minimal harness: one client of core's Harness API that leases one run at a time and runs it
 * with a plain loop. It says `hello`, then repeats: `lease`, read the session's transcript once,
 * call the Model Gate, run the `bash` calls the model asks for, and settle with `turn.completed`.
 * Every model and tool call is journaled with `effect.intent` before it runs and
 * `effect.outcome` after, so a run that starts over replays what already happened instead of
 * doing it again. It declares no workspace and uses no MCP.
 *
 * How a message's files reach the model is the harness's to decide (protocol 15): this one
 * sends each file the turn's model reads (`turn.start.model`) as its media part, and a line
 * saying it is not shown for the rest. The Model Gate refuses a part the model cannot take.
 *
 * Written only against `@nylorun/core` (its Harness API and media types); it does not use our
 * engine.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  HARNESS_API_HEADER,
  HARNESS_API_PATH,
  HARNESS_API_TRANSPORT,
  HARNESS_API_VERSION,
  HARNESS_MAX_PAYLOAD,
  MODEL_CALLS_PATH,
  createChannel,
  effectIdOf,
  effectRequestHash,
  transcriptUpdates,
  type AbortReason,
  type EffectIntent,
  type Frame,
  type HarnessChannel,
  type InputEvent,
  type ModelCall,
  type ModelCallBody,
  type ModelCallResponse,
  type ModelCallTool,
  type ModelCandidate,
  type ModelFailureOutcome,
  type OutputMethod,
  type PromptContentPart,
  type PromptItem,
  type RecordedOutcome,
  type RunGrant,
  type ToolResult,
  type TranscriptEntry,
  type TurnOutput,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { isModelImage, modelInputOf } from "@nylorun/core/contracts";
import { mediaReferenceOf } from "@nylorun/core/define";

export interface HarnessOptions {
  /** The harness id core knows this harness by (`hello.name`). */
  readonly name: string;
  readonly version?: string;
  /** The gateway's base URL (`NYLORUN_GATES_URL`), where the Model Gate is. */
  readonly gatesUrl: string;
  /** Extra variables for every command it runs: the egress proxy in a pod (`pod.ts`). */
  readonly commandEnv?: () => Record<string, string>;
  /** Stops leasing; the run in hand is given back (`lease.release`). */
  readonly signal?: AbortSignal;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A model may take this many steps in one turn. */
const MAX_STEPS = 16;
/** The longest stdout or stderr a command returns; the middle of longer output is dropped. */
const OUTPUT_LIMIT = 32 * 1024;

/**
 * The parts of an agent manifest (v7) this harness reads: the agent's instructions, and the
 * `runtime` block the Runtime pinned, with the session's sandbox, its tools and their text.
 */
interface Manifest {
  readonly id: string;
  readonly instructions?: readonly string[];
  readonly tools?: readonly ModelCallTool[];
  readonly runtime?: {
    readonly sandbox?: unknown;
    readonly tools?: readonly ModelCallTool[];
    readonly instructions?: readonly string[];
  };
}

/** The parts of a checkpoint this harness reads. `state` is what it settled the last turn with. */
interface Checkpoint {
  readonly manifestHash?: string;
  readonly segment?: number;
  readonly input?: unknown;
  readonly state?: { readonly steps?: number };
}

interface Run {
  grant: RunGrant;
  readonly start: TurnStart;
  readonly controller: AbortController;
}

/** Why a run stopped: the reason in core's `cancel`, or this harness's own. */
class Stopped extends Error {
  constructor(
    readonly reason: AbortReason,
    message: string,
  ) {
    super(message);
  }
}

const reasonOf = (signal: AbortSignal): AbortReason | undefined =>
  !signal.aborted
    ? undefined
    : signal.reason instanceof Stopped
      ? signal.reason.reason
      : "shutdown";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Opens the Harness API's WebSocket at `url` (any scheme; the path is set here). */
export async function connect(url: string, token: string): Promise<HarnessChannel> {
  const target = new URL(url);
  target.protocol = target.protocol === "https:" || target.protocol === "wss:" ? "wss:" : "ws:";
  target.pathname = HARNESS_API_PATH;
  const socket = new WebSocket(target, {
    headers: { authorization: `Bearer ${token}`, [HARNESS_API_HEADER]: HARNESS_API_TRANSPORT },
    maxPayload: HARNESS_MAX_PAYLOAD,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`The Harness API refused the connection: ${response.statusCode}`)),
    );
  });
  // Core pings every 30 s: a connection silent for 90 s is gone.
  let heard = Date.now();
  const watch = setInterval(() => Date.now() - heard > 90_000 && socket.terminate(), 10_000);
  socket.on("ping", () => (heard = Date.now()));
  const frames: ((frame: Frame) => void)[] = [];
  const closes: ((reason: string) => void)[] = [];
  socket.on("message", (data) => {
    heard = Date.now();
    const frame = JSON.parse(data.toString()) as Frame;
    for (const listener of frames) listener(frame);
  });
  socket.on("close", (code, reason) => {
    clearInterval(watch);
    for (const listener of closes) listener(reason.toString() || `closed (${code})`);
  });
  return createChannel(
    {
      send: (frame) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(frame)),
      onFrame: (listener) => frames.push(listener),
      onClose: (listener) => closes.push(listener),
      close: (reason = "closed") => socket.close(1000, reason.slice(0, 120)),
    },
    { validate: true },
  );
}

/** Says `hello` and runs leased turns one at a time until the channel closes or `signal` stops it. */
export async function serve(channel: HarnessChannel, options: HarnessOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const hello = await channel.request("hello", {
    api: HARNESS_API_VERSION,
    name: options.name,
    version: options.version ?? "0.1.0",
    features: {},
  });
  let current: Run | undefined;
  const stop = (run: Run, reason: AbortReason, message: string = reason) => {
    if (!run.controller.signal.aborted) run.controller.abort(new Stopped(reason, message));
  };
  channel.listen((method, params) => {
    const { runId, reason, message } = params as {
      runId: string;
      reason: AbortReason;
      message?: string;
    };
    if (method === "cancel" && current?.grant.runId === runId) stop(current, reason, message);
  });
  channel.onClose(() => current && stop(current, "shutdown"));
  const leasing = new AbortController();
  options.signal?.addEventListener("abort", () => {
    leasing.abort(new Stopped("shutdown", "The harness is stopping"));
    if (current) stop(current, "shutdown");
  });

  while (!channel.closed && !leasing.signal.aborted) {
    let leased;
    try {
      leased = await channel.request("lease", {}, leasing.signal);
    } catch (error) {
      if (channel.closed || leasing.signal.aborted) break;
      log("lease failed", { error: messageOf(error) });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    const run: Run = (current = {
      grant: leased.run,
      start: leased.input,
      controller: new AbortController(),
    });
    // Renew the lease while the run lasts; a renewal may carry a new run token.
    const renewing = setInterval(() => {
      if (run.controller.signal.aborted) return;
      channel.request("lease.renew", { runId: run.grant.runId }).then(
        (answer) => {
          if (!answer.ok) stop(run, "ownership.lost");
          else if (answer.token)
            run.grant = {
              ...run.grant,
              token: answer.token,
              tokenExpiresAt: answer.tokenExpiresAt,
            };
        },
        (error: unknown) => log("lease renewal failed", { error: messageOf(error) }),
      );
    }, hello.renewEveryMs);
    try {
      await runTurn(channel, options, run);
    } catch (error) {
      log("run failed", { runId: run.grant.runId, error: messageOf(error) });
    } finally {
      clearInterval(renewing);
      current = undefined;
    }
  }
}

/** One run, reported to core: an output, or the lease given back after a shutdown. */
async function runTurn(channel: HarnessChannel, options: HarnessOptions, run: Run): Promise<void> {
  const { runId } = run.grant;
  let ending: { method: OutputMethod; output: TurnOutput };
  try {
    ending = await segment(channel, options, run);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    ending = {
      method: "turn.failed",
      output: {
        runId,
        thrown: { ...(typeof code === "string" ? { code } : {}), message: messageOf(error) },
      },
    };
  }
  const reason = reasonOf(run.controller.signal);
  if (reason === "shutdown" || reason === "ownership.lost") {
    await channel.request("lease.release", { runId, reason }).catch(() => undefined);
    return;
  }
  // A cancel or a deadline ends the turn whatever the loop got to: core settles it.
  if (reason) ending = { method: "turn.failed", output: { runId, status: "cancelled" } };
  await channel.request(ending.method, ending.output);
}

/** The loop: model, tools, model, until the model answers with text. */
async function segment(
  channel: HarnessChannel,
  options: HarnessOptions,
  run: Run,
): Promise<{ method: OutputMethod; output: TurnOutput }> {
  const { runId, sessionId, turnId } = run.grant;
  const failed = (code: string, message: string) => ({
    method: "turn.failed" as const,
    output: { runId, status: "failed" as const, error: { code, message } },
  });
  const checkpoint = run.start.checkpoint as Checkpoint;
  const event = inputEventOf(checkpoint.input);
  if (run.start.engine !== "agent" || run.start.type !== "turn.start" || !event)
    return failed("harness.unsupported", "This harness runs agent turns that start from a message");

  const manifest = run.start.manifest as Manifest;
  const segmentNo = checkpoint.segment ?? 0;
  const recorded = new Map(run.start.outcomes.map((outcome) => [outcome.effectId, outcome]));
  // The sandbox's bash, from the Runtime's block, is the one tool offered. The instructions are the
  // agent's own, then the Runtime's.
  const bash =
    manifest.runtime?.sandbox === undefined
      ? undefined
      : manifest.runtime.tools?.find((tool) => tool.name === "bash");
  const tools: ModelCallTool[] = bash ? [bash] : [];
  const instructions = [...(manifest.instructions ?? []), ...(manifest.runtime?.instructions ?? [])];

  const { entries: before } = await channel.request("transcript.read", { runId });
  const added: TranscriptEntry[] = [{ kind: "input", turnId, event }];
  const journal = (effect: Effect, execute: () => Promise<unknown>) =>
    journaled(
      channel,
      run,
      recorded,
      { ...effect, agentId: manifest.id, manifestHash: checkpoint.manifestHash ?? "" },
      execute,
    );

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const stepId = `${turnId}:${segmentNo}:${step}`;
    const call: ModelCall = {
      executionId: sessionId,
      prompt: promptOf(instructions, [...(before as TranscriptEntry[]), ...added], run.start.model),
      tools,
    };
    const modelId = effectIdOf(turnId, segmentNo, "model", String(step));
    const model = await journal(
      { effectId: modelId, kind: "model", input: call, context: { invocationId: stepId } },
      () => callModel(options, run, { effectId: modelId, invocationId: stepId, call }),
    );
    if (model.status !== "completed") return suspended(runId, model);
    const answer = model.value as ModelCandidate | ModelFailureOutcome;
    if ("kind" in answer) return failed(`model.${answer.code}`, answer.message);
    added.push({ kind: "candidate", turnId, stepId, candidate: answer });

    const calls = answer.output.flatMap((block) => (block.type === "tool-call" ? [block] : []));
    if (calls.length === 0) {
      const text = answer.output
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      added.push({ kind: "final", turnId, stepId, output: text });
      return {
        method: "turn.completed",
        output: {
          runId,
          status: "completed",
          // Opaque to core: it hands it back with the next turn's checkpoint.
          state: { steps: (checkpoint.state?.steps ?? 0) + step + 1 },
          output: text,
          transcript: transcriptUpdates(before, [...before, ...added]),
        },
      };
    }

    const results: ToolResult[] = [];
    for (const toolCall of calls) {
      const identity = { callId: toolCall.id, toolName: toolCall.name };
      if (!bash || toolCall.name !== bash.name) {
        // Nothing runs, so nothing is journaled: the model hears it has no such tool.
        results.push({
          ...identity,
          kind: "failed",
          code: "tool.unknown",
          message: `No tool is named ${toolCall.name}`,
        });
        continue;
      }
      const tool = await journal(
        {
          effectId: effectIdOf(turnId, segmentNo, "tool", `${step}:${toolCall.id}`),
          kind: "tool",
          toolName: bash.name,
          input: toolCall.args,
          context: { callId: toolCall.id, invocationId: `${stepId}:${toolCall.id}`, stepId },
        },
        () => runBash(toolCall.args, run, options),
      );
      if (tool.status !== "completed") return suspended(runId, tool);
      results.push(toolResultOf(identity, tool.value));
    }
    added.push({ kind: "tool-results", turnId, stepId, results });
  }
  return failed("harness.max_steps", `The model took more than ${MAX_STEPS} steps`);
}

type Effect = Pick<EffectIntent, "effectId" | "kind" | "toolName" | "context"> & {
  input: unknown;
};
type Resolved =
  { status: "completed"; value: unknown } | { status: "pending" | "uncertain"; effectId: string };

/** A turn that waits on an effect it cannot finish: core decides what happens next. */
function suspended(runId: string, effect: Extract<Resolved, { effectId: string }>) {
  return {
    method: "turn.waiting" as const,
    output: {
      runId,
      status: effect.status === "uncertain" ? ("uncertain" as const) : ("waiting" as const),
      effectIds: [effect.effectId],
    },
  };
}

/**
 * One journaled effect. An outcome the run came with (same id, same request hash) is replayed;
 * otherwise core journals the intent first and answers `completed` (replay), `execute` (run it
 * now and report the outcome), `pending` or `uncertain` (never run it again).
 */
async function journaled(
  channel: HarnessChannel,
  run: Run,
  recorded: Map<string, RecordedOutcome>,
  effect: Effect & Pick<EffectIntent, "agentId" | "manifestHash">,
  execute: () => Promise<unknown>,
): Promise<Resolved> {
  const { runId, sessionId, turnId } = run.grant;
  const request = { ...effect, sessionId, turnId };
  // The hash covers the request with its input; a model intent crosses without its prompt.
  const requestHash = effectRequestHash(request as EffectIntent);
  const known = recorded.get(effect.effectId);
  if (known) {
    if (known.requestHash !== requestHash)
      throw Object.assign(new Error("Effect request drift"), { code: "effect_drift" });
    return { status: "completed", value: known.outcome.value };
  }
  const { input, ...withoutInput } = request;
  const intent: EffectIntent = effect.kind === "model" ? withoutInput : { ...withoutInput, input };
  const answer = await channel.request("effect.intent", { runId, effect: intent, requestHash });
  if (answer.status === "completed") return { status: "completed", value: answer.outcome.value };
  if (answer.status !== "execute") return { status: answer.status, effectId: effect.effectId };

  let value: unknown;
  try {
    value = await execute();
  } catch (error) {
    // A shutdown leaves a model call running at its gate: the next run re-sends it and joins it.
    const reason = reasonOf(run.controller.signal);
    if (reason === "shutdown" || reason === "ownership.lost") throw error;
    await channel.request("effect.outcome", {
      runId,
      effectId: effect.effectId,
      error: messageOf(error),
    });
    return { status: "uncertain", effectId: effect.effectId };
  }
  const outcome = await channel.request("effect.outcome", {
    runId,
    effectId: effect.effectId,
    value,
  });
  return outcome.status === "completed"
    ? { status: "completed", value: outcome.outcome.value }
    : { status: "uncertain", effectId: effect.effectId };
}

/** One model call through the Model Gate, keyed by its effect id. */
async function callModel(options: HarnessOptions, run: Run, body: ModelCallBody): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": body.effectId,
    ...(run.grant.token ? { authorization: `Bearer ${run.grant.token}` } : {}),
    ...(run.start.trace ? { traceparent: run.start.trace.traceparent } : {}),
  };
  const url = new URL(MODEL_CALLS_PATH, options.gatesUrl);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: run.controller.signal,
    });
    const answer = (await response.json()) as ModelCallResponse & {
      error?: { code: string; message: string };
    };
    if (!response.ok)
      throw new Error(
        `Model Gate ${response.status} ${answer.error?.code}: ${answer.error?.message}`,
      );
    return answer.outcome;
  } catch (error) {
    // A cancel stops the call at the gate too; a shutdown leaves it there for the next run.
    const reason = reasonOf(run.controller.signal);
    if (reason === "cancel" || reason === "deadline")
      await fetch(`${url}/${encodeURIComponent(body.effectId)}/cancel`, {
        method: "POST",
        headers,
      }).catch(() => undefined);
    throw error;
  }
}

let scratch: string | undefined;
/** Where commands run: the pod's `/workspace`, or a directory of this process. */
function workdir(): string {
  if (existsSync("/workspace")) return "/workspace";
  return (scratch ??= mkdtempSync(join(tmpdir(), "harness-minimal-")));
}

/** Runs one `bash` call here, as the sandbox's `bash` tool answers: exit code, stdout, stderr. */
function runBash(
  args: Record<string, unknown>,
  run: Run,
  options: HarnessOptions,
): Promise<unknown> {
  const command = String(args.command ?? "");
  const timeoutS = typeof args.timeout === "number" ? args.timeout : 120;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...run.start.routing.sandbox?.environment,
    ...options.commandEnv?.(),
    ...(run.start.trace ? { TRACEPARENT: run.start.trace.traceparent } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: workdir(),
      env,
      signal: run.controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutS * 1000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (run.controller.signal.aborted) reject(error);
      else resolve({ kind: "failed", code: "sandbox.exec_failed", message: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (run.controller.signal.aborted) return reject(run.controller.signal.reason);
      const note = timedOut ? `\nCommand timed out after ${timeoutS}s and was killed.` : "";
      resolve({
        kind: "completed",
        output: { exitCode: code ?? 137, stdout: middle(stdout), stderr: middle(stderr) + note },
      });
    });
  });
}

const middle = (text: string) =>
  text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT / 2)}\n… [${text.length - OUTPUT_LIMIT} characters omitted] …\n${text.slice(-OUTPUT_LIMIT / 2)}`;

/** A tool outcome as the model sees it next. */
function toolResultOf(identity: { callId: string; toolName: string }, value: unknown): ToolResult {
  const outcome = value as { kind?: string; output?: unknown; code?: string; message?: string };
  if (outcome?.kind === "completed")
    return { ...identity, kind: "completed", output: (outcome.output ?? null) as never };
  return {
    ...identity,
    kind: "failed",
    code: outcome?.code ?? "tool.failed",
    message: outcome?.message ?? "",
  };
}

/** What started the turn, as a transcript `input` entry's event. */
function inputEventOf(input: unknown): InputEvent | undefined {
  if (typeof input === "string") return { kind: "user-message", text: input };
  // A message's content: text, or content parts, with optional metadata.
  const value = (input ?? {}) as { kind?: unknown; text?: unknown; content?: unknown };
  if (value.kind === "user-message" || value.kind === "interrupt") return value as InputEvent;
  if (value.kind !== undefined) return undefined;
  if (typeof value.text === "string" || Array.isArray(value.content))
    return { kind: "user-message", ...value } as InputEvent;
  return undefined;
}

/** The prompt: the instructions, then the transcript projected to messages and tool results. */
export function promptOf(
  instructions: readonly string[],
  transcript: readonly TranscriptEntry[],
  model?: TurnStart["model"],
): PromptItem[] {
  const text = (value: string) => ({ type: "text" as const, text: value });
  // What the model reads; text and images when the Runtime sends no descriptor.
  const inputs: readonly string[] = model?.inputs ?? ["text", "image"];
  // A file goes as its media part when the model reads its kind natively; any other (text
  // included, which this harness does not read in) is a line saying it is not shown.
  const shown = (part: PromptContentPart): PromptContentPart => {
    if (part.type !== "media") return part;
    const kind = modelInputOf(part.mediaType);
    if (kind && kind !== "text" && inputs.includes(kind) && (kind !== "image" || isModelImage(part.mediaType)))
      return part;
    const reference = mediaReferenceOf(part.reference);
    return text(`[File ${JSON.stringify(reference?.name ?? reference?.artifactId ?? "file")} (${part.mediaType}) not shown]`);
  };
  const prompt: PromptItem[] = instructions.length
    ? [{ kind: "instructions", role: "system", content: [text(instructions.join("\n\n"))] }]
    : [];
  for (const entry of transcript) {
    if (entry.kind === "input") {
      const { event } = entry;
      if (event.kind !== "user-message" && event.kind !== "interrupt") continue;
      prompt.push({
        kind: "message",
        role: "user",
        content: "content" in event ? event.content.map(shown) : [text(event.text)],
      });
    } else if (entry.kind === "candidate") {
      const content = entry.candidate.output.flatMap((block) =>
        block.type === "text" || block.type === "tool-call" ? [block] : [],
      );
      if (content.length > 0) prompt.push({ kind: "message", role: "assistant", content });
    } else if (entry.kind === "tool-results") {
      for (const result of entry.results)
        prompt.push({
          kind: "tool-result",
          toolCallId: result.callId,
          toolName: result.toolName,
          status: result.kind,
          content: [text(JSON.stringify(result.kind === "completed" ? result.output : result))],
        });
    } else if (entry.kind === "compaction") {
      prompt.push({
        kind: "message",
        role: "user",
        content: [text(`Summary of the conversation so far:\n${entry.summary}`)],
      });
    }
  }
  return prompt;
}
