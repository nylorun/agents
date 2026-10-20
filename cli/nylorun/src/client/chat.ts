/**
 * `nylorun chat <agent> [--session <id>] [--message <text>]` (track T7): a conversation with an
 * Agent from the terminal. It opens a session on the Agent (or reuses `--session`, opening it
 * with that id when it does not exist), sends `--message` once or each line of standard input,
 * and prints the assistant's text as each model step lands, until the turn ends. A turn that
 * waits for a person (an approval, a question) prints how to answer it with `nylorun sessions`.
 * Exits 1 when a turn fails or is cancelled.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { RuntimeError, type AgentsClient, type LiveEvent, type SessionClient } from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import { parseFlags, positional, runtimeCall, runtimeClient, runtimeFlagsUsage } from "./runtime.js";

export const chatUsage = `nylorun chat <agent> [--session <id>] [--message <text>] [--owner <user>]

Talks to Agent <agent> (nylorun apply <dir> --agent makes one): sends --message once, or each
line of standard input, and prints the reply as it comes. A new session is opened unless
--session names one, which is opened with that id when it does not exist.

  --session <id>                      the session to use, kept across runs
  --message <text>                    send this one message, print the reply, and exit
  --owner <user>                      the session's owner (default the Agent's owner, else --as,
                                      else $USER)

${runtimeFlagsUsage}`;

/** Where `chat` reads its messages when `--message` is not given. */
export interface ChatIo {
  lines?: AsyncIterable<string>;
}

const errorStatus = (error: unknown) => (error instanceof RuntimeError ? error.status : undefined);

/** Sends `text` and prints the turn it starts as it streams; false when the turn failed. */
async function converse(deps: StackDeps, session: SessionClient, text: string): Promise<boolean> {
  const accepted = await runtimeCall(() => session.input(text, { idempotencyKey: randomUUID() }));
  // A message to a busy session waits in its queue; its turn starts when `queue.taken` names it.
  let turnId = accepted.status === "accepted" ? accepted.turnId : null;
  const queued = accepted.status === "queued" ? accepted.queuedMessageId : undefined;
  if (queued) deps.err(`(queued at position ${accepted.status === "queued" ? accepted.position : 0}: a turn is running)`);
  const controller = new AbortController();
  let ok = true;
  let spoke = false;
  try {
    await runtimeCall(async () => {
      for await (const event of session.observe({
        signal: controller.signal,
        ...(accepted.cursor ? { cursor: accepted.cursor } : {}),
      }) as AsyncIterable<LiveEvent>) {
        const payload = (event.payload ?? {}) as Record<string, any>;
        if (event.type === "queue.taken" && queued && Array.isArray(payload.queuedMessageIds) && payload.queuedMessageIds.includes(queued))
          turnId = String(payload.turnId);
        if (turnId === null || event.turnId !== turnId) continue;
        if (event.type === "message.assistant") {
          if (typeof payload.text === "string" && payload.text.trim() !== "") {
            deps.out(payload.text.replace(/\n+$/, ""));
            spoke = true;
          }
          for (const call of Array.isArray(payload.toolCalls) ? payload.toolCalls : []) deps.err(`[${call.name}]`);
          continue;
        }
        if (event.type === "turn.completed") {
          // A turn whose answer is structured output said no text: print the output.
          if (!spoke && payload.output !== undefined && payload.output !== null)
            deps.out(typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output, null, 2));
          break;
        }
        if (event.type === "turn.failed" || event.type === "turn.cancelled") {
          const why = payload.error?.message ?? payload.message ?? payload.reason;
          deps.err(`The turn ${event.type === "turn.failed" ? "failed" : "was cancelled"}${why ? `: ${why}` : ""}.`);
          ok = false;
          break;
        }
        if (event.type === "turn.paused") {
          for (const item of Array.isArray(payload.interactions) ? payload.interactions : []) {
            const id = item?.interaction?.id;
            const kind = item?.interaction?.kind;
            deps.err(
              kind === "approval"
                ? `The turn waits for an approval: nylorun sessions approve ${session.id} ${id} [--deny]`
                : `The turn waits for an answer (${kind}): nylorun sessions respond ${session.id} ${id} <json>`,
            );
          }
          break;
        }
      }
    });
  } finally {
    controller.abort();
  }
  return ok;
}

/** The session to talk in: `--session`, opened when missing, or a new one. */
async function sessionFor(
  deps: StackDeps,
  client: AgentsClient,
  agentId: string,
  sessionId: string | undefined,
  owner: string,
): Promise<SessionClient> {
  if (sessionId !== undefined) {
    try {
      await client.session(sessionId).inspect();
      return client.session(sessionId);
    } catch (error) {
      if (errorStatus(error) !== 404) await runtimeCall(() => Promise.reject(error));
    }
  }
  const id = sessionId ?? `chat-${randomUUID()}`;
  const session = await runtimeCall(() => client.createSession({ agent: agentId, ownerUserId: owner, id }));
  if (sessionId === undefined) deps.err(`Session ${id} on Agent ${agentId} (continue it with --session ${id}).`);
  return session;
}

/** Standard input's lines. */
async function* stdinLines(): AsyncIterable<string> {
  const lines = createInterface({ input: process.stdin, ...(process.stdin.isTTY ? { output: process.stderr, prompt: "> " } : {}) });
  if (process.stdin.isTTY) lines.prompt();
  for await (const line of lines) {
    yield line;
    if (process.stdin.isTTY) lines.prompt();
  }
}

/** `nylorun chat <agent> [--session <id>] [--message <text>] [--owner <user>]` */
export async function chatCommand(deps: StackDeps, args: readonly string[], io: ChatIo = {}): Promise<number> {
  const usage = "nylorun chat <agent> [--session <id>] [--message <text>] [--owner <user>]";
  if (args[0] === "--help" || args[0] === "-h") {
    deps.out(chatUsage);
    return 0;
  }
  const flags = parseFlags(args, { values: ["--session", "--message", "--owner"] }, usage);
  const [agentId] = positional(flags, 1, usage);
  const message = flags.values.get("--message");
  const { client } = await runtimeClient(deps, flags);
  const agent = await client.agents.get(agentId!).catch((error: unknown) => {
    if (errorStatus(error) === 404)
      throw new CliError(`No Agent ${agentId}: make one with nylorun apply <dir> --agent ${agentId}.`, 1);
    return runtimeCall(() => Promise.reject(error));
  });
  const owner =
    flags.values.get("--owner") ?? agent.owner ?? flags.values.get("--as") ?? deps.env.USER ?? deps.env.USERNAME ?? "nylorun-cli";
  const session = await sessionFor(deps, client, agentId!, flags.values.get("--session"), owner);
  if (message !== undefined) return (await converse(deps, session, message)) ? 0 : 1;
  let failed = false;
  for await (const line of io.lines ?? stdinLines()) {
    if (line.trim() === "") continue;
    if (!(await converse(deps, session, line))) failed = true;
  }
  return failed ? 1 : 0;
}
