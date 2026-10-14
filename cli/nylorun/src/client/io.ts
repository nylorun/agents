/**
 * What the `tenant` commands read and print: a JSON body from a file or standard input (`-`),
 * checked against the request's schema before anything is sent; a secret from standard input,
 * never from the arguments; and tables.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";

const usageError = (message: string) => new CliError(message, 2);

/** A request schema (`@nylorun/core/contracts`), as far as reading a body needs it. */
export interface BodySchema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/** Standard input as text; a usage error when it is a terminal or there is none. */
async function readStdin(deps: StackDeps, refusal: string): Promise<string> {
  if (!deps.stdin || deps.stdin.isTTY) throw usageError(refusal);
  return await deps.stdin.text();
}

/**
 * The JSON body in file `source`, or on standard input for `-`, as `schema` parses it. Fields
 * named in `readOnly` (a view's, so a `get` can be edited and put back) are dropped first. A
 * body that does not parse is a usage error, before any request.
 */
export async function readBody<T>(
  deps: StackDeps,
  source: string,
  schema: BodySchema<T>,
  readOnly: readonly string[] = [],
): Promise<T> {
  let text: string;
  if (source === "-") {
    text = await readStdin(deps, "Pipe the JSON body in on standard input, or name a file.");
  } else {
    try {
      text = await readFile(resolve(deps.cwd ?? process.cwd(), source), "utf8");
    } catch (error) {
      throw usageError(`Cannot read ${source}: ${(error as NodeJS.ErrnoException).code ?? error}.`);
    }
  }
  const where = source === "-" ? "Standard input" : source;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw usageError(`${where} is not JSON: ${(error as Error).message}.`);
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    value = Object.fromEntries(Object.entries(value).filter(([key]) => !readOnly.includes(key)));
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(
    (issue) => `  ${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`,
  );
  throw usageError(`${where} is not a valid body:\n${issues.join("\n")}`);
}

/**
 * A secret piped in on standard input (its trailing newline dropped), so it is never in the
 * arguments, the shell's history or the process list. `what` names it in the refusals.
 */
export async function readSecret(deps: StackDeps, what: string, example: string): Promise<string> {
  const secret = (
    await readStdin(
      deps,
      `Pipe the ${what} in on standard input, for example: ${example}. It is never taken as an argument.`,
    )
  ).trim();
  if (!secret) throw usageError(`Standard input held no ${what}.`);
  return secret;
}

/** `rows` (the first is the header) as columns two spaces apart, with no trailing blanks. */
export function printTable(deps: StackDeps, rows: readonly (readonly string[])[]): void {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  for (const row of rows)
    deps.out(
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  ")
        .trimEnd(),
    );
}

/** `value` as indented JSON on stdout. */
export function printJson(deps: StackDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}
