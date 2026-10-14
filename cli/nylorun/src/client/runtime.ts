/**
 * What the Runtime API groups (`agents`, `sessions`, `environments`, `artifacts`) share: their
 * flags, the `@nylorun/agents` client of the installation `target.ts` picks, acting for a subject
 * with `--as`, and how they read input and print output.
 */
import { readFile } from "node:fs/promises";
import {
  AgentsClient,
  RuntimeError,
  SUBJECT_SCOPES,
  type SubjectScope,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { connect, type Connection } from "./target.js";

/** Flags every Runtime API command takes. */
export const RUNTIME_FLAGS = { values: ["--tenant", "--as"], lists: ["--scope"] } as const;

export const runtimeFlagsUsage = `Every command takes --tenant <name>, and --as <subject> [--scope <scope>]... to act for a
person (default scope sessions:own; scopes: ${SUBJECT_SCOPES.join(", ")}).`;

export const usageError = (message: string) => new CliError(message, 2);

export type Flags = ReturnType<typeof parseStackFlags>;

/** `args` parsed with the Runtime flags added to `allowed`. */
export function parseFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[]; lists?: readonly string[] },
  usage: string,
): Flags {
  return parseStackFlags(
    args,
    {
      booleans: allowed.booleans ?? [],
      values: [...RUNTIME_FLAGS.values, ...(allowed.values ?? [])],
      lists: [...RUNTIME_FLAGS.lists, ...(allowed.lists ?? [])],
    },
    usage,
  );
}

/** Exactly `count` positional arguments, else a usage error. */
export function positional(flags: Flags, count: number, usage: string): string[] {
  if (flags.rest.length !== count) throw usageError(`Usage: ${usage}`);
  return flags.rest;
}

/** The Runtime API client of the installation the flags (or the environment) name. */
export async function runtimeClient(
  deps: StackDeps,
  flags: Flags,
): Promise<{ client: AgentsClient; connection: Connection }> {
  const scopes = flags.lists.get("--scope");
  const subject = flags.values.get("--as");
  if (scopes && subject === undefined) throw usageError("--scope needs --as <subject>.");
  for (const scope of scopes ?? [])
    if (!(SUBJECT_SCOPES as readonly string[]).includes(scope))
      throw usageError(`Unknown scope ${scope}: one of ${SUBJECT_SCOPES.join(", ")}.`);
  const connection = await connect(deps, "runtime", flags.values.get("--tenant"));
  const fetch: typeof globalThis.fetch = (input, init) =>
    deps.fetch(input instanceof Request ? input.url : String(input), init);
  const token = connection.token;
  if (!token && !connection.applicationKey)
    throw new CliError(`No application key for ${connection.label}: set NYLORUN_SERVER_KEY.`, 1);
  const base = new AgentsClient({
    url: connection.url,
    fetch,
    ...(token
      ? { token: { get: async () => token, invalidate: () => {} } }
      : { key: connection.applicationKey! }),
  });
  const client =
    subject === undefined
      ? base
      : base.as(subject, scopes ? { scopes: scopes as SubjectScope[] } : {});
  return { client, connection };
}

/** Runs `command`, turning a Runtime's refusal into a `CliError` with its message (exit 1). */
export async function runtimeCall<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    const body = error.body as { code?: unknown; message?: unknown } | undefined;
    const message = typeof body?.message === "string" ? body.message : error.message;
    const code = typeof body?.code === "string" ? ` (${body.code})` : "";
    throw new CliError(`${message.replace(/\.$/, "")}${code}. HTTP ${error.status}.`, 1);
  }
}

/** Standard input, whole. */
export async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A JSON object from file `path`, or from standard input when `path` is `-`. */
export async function readJson(path: string, what: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = path === "-" ? (await readStdin()).toString("utf8") : await readFile(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${what.toLowerCase()} from ${path}: ${(error as Error).message}`, 1);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw usageError(`${what} is not JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usageError(`${what} must be a JSON object.`);
  return value as Record<string, unknown>;
}

/** A JSON value given on the command line. */
export function parseJsonArgument(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usageError(`${what} is not JSON: ${(error as Error).message}`);
  }
}

/** `key=value` pairs (`--label`), as a record. */
export function labelsOf(flags: Flags, name = "--label"): Record<string, string> | undefined {
  const pairs = flags.lists.get(name);
  if (!pairs) return undefined;
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw usageError(`${name} must be key=value, not ${pair}`);
    labels[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return labels;
}

/** A positive integer flag, when given. */
export function integerFlag(flags: Flags, name: string): number | undefined {
  const raw = flags.values.get(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usageError(`${name} must be a whole number, not ${raw}`);
  return Number(raw);
}

export { printJson, printTable } from "./io.js";

/** A page's `next cursor` hint, when there is one. */
export function printCursor(deps: StackDeps, cursor: string | null | undefined): void {
  if (cursor) deps.err(`More: --cursor ${cursor}`);
}
