/**
 * `nylorun init <path>` (tracks T6 and T7): writes a new agent folder's `AGENT.md`, named after
 * the path's last segment (`init agents/hello` names it `hello`). `--example` adds a tool, an
 * MCP server and a trigger, each explained in the folder's README.md, and the result passes
 * `nylorun check`. It also sets up the project, at the nearest directory with `.git` (else the
 * working directory), once:
 *
 * - `.gitattributes` with `* text=auto eol=lf` when there is none, so a Windows checkout keeps
 *   LF line endings;
 * - `.nylorun/credentials.json` in `.gitignore` when nothing ignores it yet;
 * - the editor's schema mapping (design §3.10): `.vscode/settings.json` `json.schemas`, merged into
 *   the file, which is left alone when it is not plain JSON.
 *
 * It reads no Runtime.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isAgentManifestName } from "@nylorun/core/contracts";
import { AGENT_FOLDER_FILE, ignoreMatcher } from "@nylorun/agents";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { usageError } from "./runtime.js";

export const initUsage = `nylorun init <path> [--description <text>] [--example]

Writes <path>/AGENT.md, the smallest agent folder: frontmatter with its name (the path's last
segment, so init agents/hello names it hello) and description, and its instructions below.

  --example                           also write tools/get_order.json, mcp.json and
                                      triggers/new-order.md, with a README.md that explains each

The first run in a project (the nearest directory with .git, else this one) also writes
.gitattributes (* text=auto eol=lf), ignores .nylorun/credentials.json in .gitignore, and maps the
folder files to their JSON Schemas in .vscode/settings.json, each only when it is missing.`;

/** Where the editor finds each agent folder file's schema (design §3.10). */
export const SCHEMA_BASE = "https://docs.nylorun.com/schemas/agent-folder/v1";

/** The project `init` sets up: the nearest directory from `cwd` up with `.git`, else `cwd`. */
export function projectRootOf(cwd: string): string {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return directory;
    if (dirname(directory) === directory) return resolve(cwd);
  }
}

/** `json.schemas` entries for the agent folders that sit where `folder` does, under `root`. */
export function schemaMappings(root: string, folder: string): { fileMatch: string[]; url: string }[] {
  const parent = relative(root, dirname(folder)).split(sep).join("/");
  // Folders under a parent (agents/) share one pattern; a folder at the root is named alone.
  const base = parent === "" ? relative(root, folder).split(sep).join("/") : `${parent}/**`;
  return [
    { fileMatch: [`${base}/runtime.json`], url: `${SCHEMA_BASE}/runtime.json` },
    { fileMatch: [`${base}/tools/*.json`], url: `${SCHEMA_BASE}/tool.json` },
    { fileMatch: [`${base}/flow.json`], url: `${SCHEMA_BASE}/flow.json` },
    { fileMatch: [`${base}/mcp.json`, `!${base}/plugins/**`], url: `${SCHEMA_BASE}/mcp.json` },
  ];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `settings` with `mappings` merged into its `json.schemas`: a mapping whose URL is there already
 * gains the patterns it lacks. Undefined when nothing changes.
 */
export function mergeSchemaSettings(
  settings: Record<string, unknown>,
  mappings: readonly { fileMatch: string[]; url: string }[],
): Record<string, unknown> | undefined {
  const existing = Array.isArray(settings["json.schemas"]) ? (settings["json.schemas"] as unknown[]) : [];
  const schemas = existing.map((item) => (isObject(item) ? { ...item } : item));
  let changed = !Array.isArray(settings["json.schemas"]);
  for (const mapping of mappings) {
    const found = schemas.find((item): item is Record<string, unknown> => isObject(item) && item.url === mapping.url);
    if (!found) {
      schemas.push({ fileMatch: [...mapping.fileMatch], url: mapping.url });
      changed = true;
      continue;
    }
    const patterns = Array.isArray(found.fileMatch) ? (found.fileMatch as unknown[]) : [];
    const missing = mapping.fileMatch.filter((pattern) => !patterns.includes(pattern));
    if (missing.length === 0) continue;
    found.fileMatch = [...patterns, ...missing];
    changed = true;
  }
  return changed ? { ...settings, "json.schemas": schemas } : undefined;
}

/** A file's text, or undefined when there is none. */
const textOf = (path: string) => readFile(path, "utf8").catch(() => undefined);

/** Sets up the project at `root` for the agent folder `folder`; each line says what it wrote. */
async function setUpProject(root: string, folder: string, show: (path: string) => string): Promise<string[]> {
  const notes: string[] = [];
  const attributes = join(root, ".gitattributes");
  if (!existsSync(attributes)) {
    await writeFile(attributes, "* text=auto eol=lf\n", { flag: "wx" });
    notes.push(`Wrote ${show(attributes)} (* text=auto eol=lf), so a Windows checkout keeps LF line endings.`);
  }

  const ignore = join(root, ".gitignore");
  const ignoreText = (await textOf(ignore)) ?? "";
  if (!ignoreMatcher(ignoreText)(".nylorun/credentials.json")) {
    const separator = ignoreText === "" || ignoreText.endsWith("\n") ? "" : "\n";
    await writeFile(ignore, `${ignoreText}${separator}.nylorun/credentials.json\n`);
    notes.push(`Added .nylorun/credentials.json to ${show(ignore)}.`);
  }

  const settingsPath = join(root, ".vscode", "settings.json");
  const settingsText = await textOf(settingsPath);
  let settings: unknown = {};
  if (settingsText !== undefined) {
    try {
      settings = JSON.parse(settingsText);
    } catch {
      settings = undefined;
    }
  }
  const mappings = schemaMappings(root, folder);
  const merged = isObject(settings) ? mergeSchemaSettings(settings, mappings) : undefined;
  if (!isObject(settings))
    notes.push(
      `${show(settingsPath)} is not plain JSON, so it was left alone: add the agent folder schemas to its json.schemas (${SCHEMA_BASE}/<kind>.json).`,
    );
  else if (merged) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    notes.push(`Mapped the agent folder files to their JSON Schemas in ${show(settingsPath)}.`);
  }
  return notes;
}

/** The files `--example` adds, by path in the folder. */
function exampleFiles(name: string): Record<string, string> {
  const tool = {
    description: "Look up one order by its id: its status, items and total.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string", description: "The order's id, such as A-1001." } },
      required: ["orderId"],
      additionalProperties: false,
    },
    http: { url: "https://orders.example.com/lookup", method: "POST", timeoutMs: 15000, credential: "ORDERS_TOKEN" },
  };
  const mcp = {
    mcpServers: {
      orders: {
        type: "streamable-http",
        url: "https://orders.example.com/mcp",
        headers: { Authorization: "Bearer ${ORDERS_MCP_TOKEN}" },
      },
    },
  };
  const trigger = `---
# A trigger starts a turn with no person in the chat. This one is a webhook: the Runtime gives it
# a URL and a signing secret (nylorun agents triggers new-secret ${name} new-order), and each signed
# POST runs the prompt below.
# On a schedule instead: schedule: "0 9 * * 1-5" with timezone: Europe/London, and no webhook.
# Once, at a set time: at: 2026-11-01T09:00:00+05:30, and no webhook.
webhook: standard-webhooks
# Each run opens a new session. A session id here sends every run to that one session.
session: new
---
A new order arrived. Look it up with get_order and summarize it in two sentences.
`;
  const readme = `# ${name}

An agent folder (\`nylorun init --example\`). \`nylorun check\` compiles it offline, and
\`nylorun apply --agent\` saves it and makes the Agent \`${name}\`. Every file but this one is part
of the agent; the example ones are placeholders to replace or delete.

- \`AGENT.md\`: the name and description (frontmatter), then the instructions.
- \`tools/get_order.json\`: an HTTP tool. The file name is the tool's name; the model reads its
  \`description\` and \`inputSchema\`. \`http.credential\` names a secret slot, \`ORDERS_TOKEN\`, sent as
  a bearer token: set it with \`nylorun agents secrets put ${name} ORDERS_TOKEN\` (piped in).
- \`mcp.json\`: MCP servers, in Agent Plugins syntax. \`\${ORDERS_MCP_TOKEN}\` in a header is a secret
  slot too, never a value: never write a literal token here.
- \`triggers/new-order.md\`: a trigger. The frontmatter says when it fires (\`webhook\`, \`schedule\` or
  \`at\`) and which session it runs in; the body is the prompt. Its comments show the other kinds.

Until a required secret is set, the Agent lists it under \`attention\` (\`nylorun agents get ${name}\`).
`;
  return {
    "tools/get_order.json": `${JSON.stringify(tool, null, 2)}\n`,
    "mcp.json": `${JSON.stringify(mcp, null, 2)}\n`,
    "triggers/new-order.md": trigger,
    "README.md": readme,
  };
}

/** `nylorun init <path> [--description <text>] [--example]` */
export async function initCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { values: ["--description"], booleans: ["--example"] }, initUsage);
  const [path, ...rest] = flags.rest;
  if (path === undefined || rest.length > 0) throw usageError(`Usage: ${initUsage.split("\n")[0]}`);
  const cwd = deps.cwd ?? process.cwd();
  const dir = resolve(cwd, path);
  const name = basename(dir);
  if (!isAgentManifestName(name))
    throw usageError(`${name} is not an agent's name: 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit.`);
  const show = (file: string) => relative(cwd, file) || ".";
  const file = join(dir, AGENT_FOLDER_FILE);
  const example = flags.booleans.has("--example");
  const files: Record<string, string> = {
    [AGENT_FOLDER_FILE]: `---\nname: ${name}\ndescription: ${JSON.stringify(
      flags.values.get("--description") ?? `Describe what ${name} does in one sentence.`,
    )}\n---\nYou are ${name}. Write the agent's instructions here, in Markdown.\n${
      example ? "\nLook an order up with get_order before you answer a question about it.\n" : ""
    }`,
    ...(example ? exampleFiles(name) : {}),
  };
  for (const relativePath of Object.keys(files))
    if (existsSync(join(dir, relativePath))) throw new CliError(`${show(join(dir, relativePath))} exists already.`, 1);
  for (const [relativePath, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, relativePath)), { recursive: true });
    await writeFile(join(dir, relativePath), text, { flag: "wx" });
  }
  deps.out(example ? `Wrote ${show(dir)}/: ${Object.keys(files).join(", ")}.` : `Wrote ${show(file)}.`);
  for (const note of await setUpProject(projectRootOf(cwd), dir, show)) deps.out(note);
  const at = show(dir);
  deps.out(
    `Next: nylorun check ${at}, then nylorun apply ${at} --agent to save it and make the Agent ${name}, then nylorun chat ${name}.`,
  );
  return 0;
}
