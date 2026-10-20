/**
 * Agent folders (track T6, D79): `compileAgentFolder` turns a folder of Markdown and JSON into
 * the agent manifest v8 the Runtime runs. It is pure: it reads no file system, clock, network
 * or environment, only the folder's entries and the bytes of the files it compiles, so the
 * Runtime (on every upload) and the CLI (`nylorun check`, offline) give one verdict. Every
 * problem comes back in one pass, each naming its file and, for parse and schema errors, its
 * line and column.
 *
 * Format `agent-folder/1`, agents only:
 *
 * - `AGENT.md`: frontmatter (`name`, `description`, `format`, `harness`, `outputSchema`,
 *   `mcpServers`, `skills`, `memory`, `loop`, `metadata`); the body is the instructions, then
 *   each of `instructions/*.md` in path order.
 * - `runtime.json`: the runtime section. Without one, a folder that needs a runtime section (a
 *   derived secret slot, a trigger, files) gets kind `none`.
 * - `mcp.json`: MCP servers in Agent Plugins syntax. `${NAME}` in a header names the secret
 *   slot the server authenticates with (`Bearer ${NAME}` a `bearer` slot, `${NAME}` alone a
 *   `headers` slot); the header leaves the manifest, and a slot `runtime.json` does not declare
 *   is derived for the server's URL.
 * - `skills/<name>/`: Agent Skills; `SKILL.md` takes the spec's keys only.
 * - `tools/<name>.json`: an HTTP tool; its schemas inline or a path to a JSON Schema file.
 * - `triggers/<id>.md`: frontmatter `schedule` and `timezone`, `at` or `webhook`, and `session`;
 *   the body is the prompt.
 * - `files/**`: copied under `/workspace` when a disk is made.
 * - JSON Schema files: `output.schema.json`, `*.schema.json` and `schemas/**.json`, read when a
 *   path names them.
 *
 * Flows (`flow.json`, `agents/`) and vendored plugins (`plugins/`) are refused: they come later.
 * Any other file is kept with the source and noted.
 */
import type { z } from "zod";
import {
  AGENT_MANIFEST_V8_SCHEMA_VERSION,
  AgentManifestV8Schema,
  ENVIRONMENT_NAME_PATTERN,
  HarnessIdSchema,
  RuntimeSectionSchema,
  TOOL_SECRET_NAME_PATTERN,
  TriggerSchema,
  isAgentManifestName,
  type AgentManifestV8,
} from "../contracts.js";
import { DELEGATE_NAME_PATTERN } from "../definition/delegate.js";
import { SKILL_ENTRY, skillFilePathIssue } from "../utils/definition-files.js";
import { parseMarkdown } from "./frontmatter.js";
import { parseJson, pointerOf, type Located, type Position } from "./json.js";

/** The compiler format this version builds: a folder with no `format`, or `format: 1`. */
export const AGENT_FOLDER_COMPILER = "agent-folder/1";

/** What a folder may hold. Fixed in this version; Tenant settings come later. */
export const AGENT_FOLDER_LIMITS = Object.freeze({
  /** Files in one folder. */
  files: 2000,
  /** Every file's bytes together. */
  totalBytes: 50 * 1024 * 1024,
  /** One Markdown or JSON file the compiler reads. */
  textFileBytes: 1024 * 1024,
});

/** One file of a folder: its `/`-separated path, size and SHA-256 (lowercase hex). */
export interface AgentFolderEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * One problem or remark: an `error` keeps the folder from compiling; `warning`, `info` and
 * `note` do not. `file` is the folder path it is about, with the line and column when known,
 * and `pointer` the field in the manifest when it is about one.
 */
export interface AgentFolderDiagnostic {
  readonly severity: "error" | "warning" | "info" | "note";
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: string;
}

export interface CompileAgentFolderInput {
  readonly entries: readonly AgentFolderEntry[];
  /** The bytes of each file `folderTextPaths(entries)` names. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The name the manifest must have: the path's, or the folder's. */
  readonly name?: string;
}

export interface CompiledAgentFolder {
  /** The manifest, when nothing is an error. */
  readonly manifest?: AgentManifestV8;
  readonly diagnostics: readonly AgentFolderDiagnostic[];
  readonly compiler: typeof AGENT_FOLDER_COMPILER;
}

const AGENT_FILE = "AGENT.md";
const RUNTIME_FILE = "runtime.json";
const MCP_FILE = "mcp.json";
const OUTPUT_SCHEMA_FILE = "output.schema.json";
const WORKSPACE = "/workspace";
const AGENT_PLUGINS_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_KEYS = ["name", "description", "format", "harness", "outputSchema", "mcpServers", "skills", "memory", "loop", "metadata"];
const SKILL_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
const TRIGGER_KEYS = ["schedule", "timezone", "at", "webhook", "session"];
const SERVER_KEYS = ["type", "url", "headers"];
const SERVER_SETTING_KEYS = ["deferred", "tools"];
const TOOL_KEYS = ["description", "inputSchema", "outputSchema", "http", "approval"];

type Kind =
  | "agent"
  | "instructions"
  | "runtime"
  | "mcp"
  | "tool"
  | "trigger"
  | "skill"
  | "file"
  | "schema"
  | "other";

const isEnvFile = (name: string) => name === ".env" || name.startsWith(".env.");

/** What a path is, or why the folder may not hold it. */
function classify(path: string): { kind: Kind } | { error: string; code: string } {
  const segments = path.split("/");
  const base = segments.at(-1)!;
  if (segments.includes(".git") || segments.includes("node_modules"))
    return { code: "path_refused", error: ".git/ and node_modules/ are not part of an agent folder: leave them out of the upload" };
  if (isEnvFile(base))
    return { code: "secret_file", error: "Environment files hold secrets and never go in an agent folder: a secret is a slot in runtime.json, and its value goes to the Agent's vault" };
  const top = segments[0]!;
  if ((base.endsWith(".pem") || base.endsWith(".key")) && top !== "skills" && top !== "files")
    return { code: "secret_file", error: "Key files never go in an agent folder outside skills/ and files/: a secret is a slot in runtime.json, and its value goes to the Agent's vault" };
  if (path === AGENT_FILE) return { kind: "agent" };
  if (path === RUNTIME_FILE) return { kind: "runtime" };
  if (path === MCP_FILE) return { kind: "mcp" };
  if (segments.length === 1) {
    if (base.toLowerCase() === "agent.md") return { code: "wrong_name", error: `The root file is named ${AGENT_FILE}, in capitals` };
    const stem = base.replace(/\.(?:ya?ml|jsonc|json5)$/, "");
    if (stem !== base && ["runtime", "mcp", "AGENT"].includes(stem))
      return { code: "wrong_syntax", error: `Write this file as ${stem === "AGENT" ? AGENT_FILE : `${stem}.json`}: an agent folder has one syntax per kind of file` };
    if (path === "flow.json")
      return { code: "not_supported", error: `Flows (flow.json) are not in ${AGENT_FOLDER_COMPILER} yet: save the flow as JSON or with the TypeScript builder` };
    if (base.endsWith(".schema.json")) return { kind: "schema" };
    return { kind: "other" };
  }
  if (top === "agents" || top === "plugins")
    return {
      code: "not_supported",
      error: `${top}/ is not in ${AGENT_FOLDER_COMPILER} yet: ${top === "agents" ? "subagents and flows" : "vendored Agent Plugins"} come in a later version`,
    };
  if (top === "instructions")
    return segments.length === 2 && base.endsWith(".md")
      ? { kind: "instructions" }
      : { code: "reserved_directory", error: "instructions/ holds Markdown files only, with no folders" };
  if (top === "tools")
    return segments.length === 2 && base.endsWith(".json")
      ? { kind: "tool" }
      : { code: "reserved_directory", error: "tools/ holds one JSON file per HTTP tool, named <tool>.json" };
  if (top === "triggers")
    return segments.length === 2 && base.endsWith(".md")
      ? { kind: "trigger" }
      : { code: "reserved_directory", error: "triggers/ holds one Markdown file per trigger, named <id>.md" };
  if (top === "skills")
    return segments.length >= 3 ? { kind: "skill" } : { code: "reserved_directory", error: "skills/ holds one folder per skill, each with its SKILL.md" };
  if (top === "files") return { kind: "file" };
  if (top === "schemas")
    return base.endsWith(".json") ? { kind: "schema" } : { code: "reserved_directory", error: "schemas/ holds JSON Schema files (.json)" };
  if (top === ".nylorun") return { kind: "other" };
  if (base.endsWith(".schema.json")) return { kind: "schema" };
  return { kind: "other" };
}

/** The files the compiler reads: the Runtime and the CLI pass their bytes in. */
export function folderTextPaths(entries: readonly AgentFolderEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const kind = classify(entry.path);
    if (!("kind" in kind)) continue;
    const textual =
      kind.kind === "agent" ||
      kind.kind === "instructions" ||
      kind.kind === "runtime" ||
      kind.kind === "mcp" ||
      kind.kind === "tool" ||
      kind.kind === "trigger" ||
      kind.kind === "schema" ||
      (kind.kind === "skill" && entry.path.split("/").length === 3 && entry.path.endsWith(`/${SKILL_ENTRY}`));
    if (textual) paths.push(entry.path);
  }
  return paths.sort(compare);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why `path` cannot name a file in a folder, or undefined when it can. */
function pathIssue(path: string): string | undefined {
  if (path.length === 0 || path.length > 1024) return "must be 1 to 1024 characters";
  if (path.includes("\\")) return "must use / as its separator, not \\";
  if (path.startsWith("/")) return "must be relative to the folder";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "must not contain control characters";
  if (path !== path.normalize("NFC")) return "must be in Unicode NFC";
  for (const segment of path.split("/"))
    if (segment === "" || segment === "." || segment === "..") return "must not have empty, . or .. segments";
  return undefined;
}

/** The closest of `known` to `name`, when one is close enough to be a typo. */
function suggestion(name: string, known: readonly string[]): string | undefined {
  let best: { value: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(candidate.length / 3)) && (!best || distance < best.distance))
      best = { value: candidate, distance };
  }
  return best?.value;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

const unknownKeyMessage = (key: string, known: readonly string[]) => {
  const close = suggestion(key, known);
  return `Unknown key '${key}'.${close ? ` Did you mean '${close}'?` : ` Known keys: ${known.join(", ")}.`}`;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One parsed file: its data and where each pointer in it is. */
interface ParsedFile {
  readonly path: string;
  readonly positions: ReadonlyMap<string, Located>;
}

/** Where a manifest field came from: a file, and the pointer in it. */
interface Origin {
  readonly file: string;
  readonly path: readonly PropertyKey[];
}

/** Compiles an agent folder into agent manifest v8, with every diagnostic. */
export function compileAgentFolder(input: CompileAgentFolderInput): CompiledAgentFolder {
  const diagnostics: AgentFolderDiagnostic[] = [];
  const parsed = new Map<string, ParsedFile>();
  const report = (
    severity: AgentFolderDiagnostic["severity"],
    code: string,
    message: string,
    file?: string,
    path?: readonly PropertyKey[],
    options: { key?: boolean; at?: Position; pointer?: string } = {},
  ) => {
    let at = options.at;
    if (!at && file && path) {
      const found = locate(parsed.get(file), path);
      at = options.key ? (found?.key ?? found?.value) : found?.value;
    }
    diagnostics.push({
      severity,
      code,
      message,
      ...(file === undefined ? {} : { file }),
      ...(at === undefined ? {} : { line: at.line, column: at.column }),
      ...(options.pointer === undefined ? {} : { pointer: options.pointer }),
    });
  };
  const error = (code: string, message: string, file?: string, path?: readonly PropertyKey[], options: { key?: boolean; at?: Position; pointer?: string } = {}) =>
    report("error", code, message, file, path, options);

  // --- The entries ------------------------------------------------------------------------
  const entries = [...input.entries].sort((a, b) => compare(a.path, b.path));
  const byPath = new Map<string, AgentFolderEntry>();
  const folded = new Map<string, string>();
  let bytes = 0;
  for (const entry of entries) {
    const issue = pathIssue(entry.path);
    if (issue) {
      error("path_invalid", `The path ${JSON.stringify(entry.path.slice(0, 200))} ${issue}`, entry.path);
      continue;
    }
    if (byPath.has(entry.path)) {
      error("path_duplicate", "The folder lists this path twice", entry.path);
      continue;
    }
    const lower = entry.path.toLowerCase();
    const other = folded.get(lower);
    if (other !== undefined) {
      error("path_case", `This path and ${other} differ only in case, which some file systems cannot hold`, entry.path);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      error("path_invalid", "The file's sha256 is not 64 lowercase hex digits", entry.path);
      continue;
    }
    folded.set(lower, entry.path);
    byPath.set(entry.path, entry);
    bytes += entry.size;
  }
  if (entries.length > AGENT_FOLDER_LIMITS.files)
    error("limit_exceeded", `An agent folder holds at most ${AGENT_FOLDER_LIMITS.files} files; this one holds ${entries.length}`);
  if (bytes > AGENT_FOLDER_LIMITS.totalBytes)
    error("limit_exceeded", `An agent folder holds at most ${AGENT_FOLDER_LIMITS.totalBytes} bytes; this one holds ${bytes}`);

  const kinds = new Map<string, Kind>();
  for (const path of byPath.keys()) {
    const kind = classify(path);
    if ("kind" in kind) kinds.set(path, kind.kind);
    else error(kind.code, kind.error, path);
  }
  for (const [path, kind] of kinds)
    if (kind === "other") report("note", "file_not_compiled", "Kept with the source; not part of the agent", path);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  /** The text of a file the compiler reads, or undefined after reporting why it has none. */
  const textOf = (path: string): string | undefined => {
    const entry = byPath.get(path);
    if (!entry) return undefined;
    if (entry.size > AGENT_FOLDER_LIMITS.textFileBytes) {
      error("limit_exceeded", `A Markdown or JSON file holds at most ${AGENT_FOLDER_LIMITS.textFileBytes} bytes; this one holds ${entry.size}`, path);
      return undefined;
    }
    const bytesOf = input.files.get(path);
    if (!bytesOf) {
      error("file_missing", "The compiler was not given this file's bytes", path);
      return undefined;
    }
    try {
      return decoder.decode(bytesOf).replace(/^﻿/, "");
    } catch {
      error("not_utf8", "The file is not UTF-8 text", path);
      return undefined;
    }
  };
  const readJson = (path: string): Record<string, unknown> | undefined => {
    const text = textOf(path);
    if (text === undefined) return undefined;
    const result = parseJson(text);
    if (!result.ok) {
      error("json_invalid", result.message, path, undefined, { at: result.at });
      return undefined;
    }
    parsed.set(path, { path, positions: result.positions });
    if (!isObject(result.value)) {
      error("json_invalid", "The file holds a JSON object", path, []);
      return undefined;
    }
    return result.value;
  };
  const readMarkdown = (path: string) => {
    const text = textOf(path);
    if (text === undefined) return undefined;
    const result = parseMarkdown(text);
    if (!result.ok) {
      error("frontmatter_invalid", result.message, path, undefined, { at: result.at });
      return undefined;
    }
    parsed.set(path, { path, positions: result.positions });
    return result;
  };
  const checkKeys = (file: string, value: Record<string, unknown>, known: readonly string[], path: readonly PropertyKey[] = []) => {
    for (const key of Object.keys(value))
      if (!known.includes(key)) error("unknown_key", unknownKeyMessage(key, known), file, [...path, key], { key: true });
  };
  /** A JSON Schema a field names by path (`./x.json` from the root, `/x.json`), or inline. */
  const schemaAt = (file: string, field: readonly PropertyKey[], value: unknown): Record<string, unknown> | undefined => {
    if (isObject(value)) return value;
    if (typeof value !== "string") {
      error("schema_invalid", "A schema is a JSON Schema object, or a path to a JSON Schema file", file, field);
      return undefined;
    }
    const target = value.startsWith("/") ? value.slice(1) : value.replace(/^\.\//, "");
    if (target.split("/").some((segment) => segment === ".." || segment === "")) {
      error("path_outside", `${value} leaves the folder: a path names a file inside it`, file, field);
      return undefined;
    }
    if (!byPath.has(target)) {
      error("schema_missing", `${value} is not a file in the folder`, file, field);
      return undefined;
    }
    if (kinds.get(target) !== "schema") {
      error("schema_invalid", `${value} is not a JSON Schema file: name it *.schema.json or keep it under schemas/`, file, field);
      return undefined;
    }
    return readJson(target);
  };

  // --- AGENT.md ---------------------------------------------------------------------------
  if (!byPath.has(AGENT_FILE)) error("agent_missing", `An agent folder has an ${AGENT_FILE} at its root, with name and description in its frontmatter`);
  const agent = byPath.has(AGENT_FILE) ? readMarkdown(AGENT_FILE) : undefined;
  const front = agent?.data ?? {};
  let name: string | undefined;
  let description: string | undefined;
  const harness: Record<string, unknown> = {};
  const instructions: string[] = [];
  let metadata: Record<string, unknown> | undefined;
  const origins: [readonly PropertyKey[], Origin][] = [];
  if (agent) {
    if (!agent.hasFrontmatter)
      error("frontmatter_missing", `${AGENT_FILE} opens with frontmatter between --- lines, with name and description`, AGENT_FILE, undefined, { at: { line: 1, column: 1 } });
    checkKeys(AGENT_FILE, front, AGENT_KEYS);
    if (typeof front.name !== "string" || front.name === "")
      error("name_missing", "name is required: the agent manifest's name", AGENT_FILE, front.name === undefined ? undefined : ["name"]);
    else if (!isAgentManifestName(front.name))
      error("name_invalid", "name is 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit", AGENT_FILE, ["name"]);
    else if (input.name !== undefined && front.name !== input.name)
      error("name_mismatch", `name is ${front.name}, and the folder is saved as ${input.name}: they must match`, AGENT_FILE, ["name"]);
    else name = front.name;
    if (typeof front.description !== "string" || front.description.trim() === "")
      error("description_missing", "description is required: what the agent does, in a sentence", AGENT_FILE, front.description === undefined ? undefined : ["description"]);
    else description = front.description.trim();
    if (front.format !== undefined && front.format !== 1)
      error("format_unsupported", `format ${JSON.stringify(front.format)} is not supported: this compiler builds format 1 (${AGENT_FOLDER_COMPILER})`, AGENT_FILE, ["format"]);
    if (front.harness !== undefined) {
      if (HarnessIdSchema.safeParse(front.harness).success) harness.id = front.harness;
      else error("harness_invalid", "harness is the id of the harness that runs the loop, such as nylorun", AGENT_FILE, ["harness"]);
    }
    if (front.outputSchema !== undefined) {
      const schema = schemaAt(AGENT_FILE, ["outputSchema"], front.outputSchema);
      if (schema) harness.outputSchema = schema;
    }
    for (const key of ["memory", "loop"] as const) {
      if (front[key] === undefined) continue;
      if (isObject(front[key])) harness[key] = front[key];
      else error("value_invalid", `${key} is a map`, AGENT_FILE, [key]);
    }
    if (front.metadata !== undefined) {
      if (isObject(front.metadata)) metadata = front.metadata;
      else error("value_invalid", "metadata is a map", AGENT_FILE, ["metadata"]);
    }
    const body = trimBlankLines(agent.body);
    if (body !== "") instructions.push(body);
    origins.push([["harness", "instructions"], { file: AGENT_FILE, path: [] }]);
    for (const key of ["memory", "loop", "outputSchema"])
      origins.push([["harness", key], { file: AGENT_FILE, path: [key] }]);
    origins.push([["harness", "id"], { file: AGENT_FILE, path: ["harness"] }]);
  }
  for (const path of [...kinds].filter(([, kind]) => kind === "instructions").map(([path]) => path)) {
    const text = textOf(path);
    if (text === undefined) continue;
    const trimmed = trimBlankLines(text);
    if (trimmed !== "") instructions.push(trimmed);
  }
  if (instructions.length > 0) harness.instructions = instructions;

  // --- runtime.json ----------------------------------------------------------------------
  let runtime: Record<string, unknown> | undefined;
  if (byPath.has(RUNTIME_FILE)) {
    const value = readJson(RUNTIME_FILE);
    if (value) {
      if ("$schema" in value)
        error("schema_key", "runtime.json takes no $schema: the path gives the kind, and the folder its format", RUNTIME_FILE, ["$schema"], { key: true });
      if ("extends" in value)
        error("not_supported", `extends is not in ${AGENT_FOLDER_COMPILER} yet: write the whole runtime section here`, RUNTIME_FILE, ["extends"], { key: true });
      const { $schema: _, extends: __, ...rest } = value;
      runtime = rest;
      origins.push([["runtime"], { file: RUNTIME_FILE, path: [] }]);
    }
  }
  const derivedSlots = new Map<string, { slot: Record<string, unknown>; file: string; path: readonly PropertyKey[]; url: string }>();
  /** A slot for `credential`, derived when runtime.json does not declare it. */
  const deriveSlot = (credential: string, type: "bearer" | "headers", url: string, file: string, path: readonly PropertyKey[], header?: string) => {
    const declared = isObject(runtime?.secrets) ? runtime.secrets[credential] : undefined;
    if (declared !== undefined) return;
    const existing = derivedSlots.get(credential);
    if (existing) {
      if (existing.url !== url || existing.slot.type !== type) {
        const at = locate(parsed.get(existing.file), existing.path)?.value;
        error(
          "credential_urls",
          `${credential} is the credential of ${existing.url} (${existing.file}${at ? `:${at.line}` : ""}) and of ${url}: a slot is bound to one URL, so give each URL its own slot`,
          file,
          path,
        );
      }
      return;
    }
    const slot: Record<string, unknown> = {
      type,
      url,
      required: true,
      ...(header ? { description: `Sets the ${header} header` } : {}),
    };
    derivedSlots.set(credential, { slot, file, path, url });
    report("info", "slot_derived", `A ${type} slot ${credential} is derived for ${url}`, file, path, { pointer: pointerOf(["runtime", "secrets", credential]) });
  };

  // --- mcp.json --------------------------------------------------------------------------
  const servers: Record<string, Record<string, unknown>> = {};
  let mcpRead = false;
  if (byPath.has(MCP_FILE)) {
    const value = readJson(MCP_FILE);
    if (value) {
      mcpRead = true;
      checkKeys(MCP_FILE, value, ["$schema", "mcpServers"]);
      if (value.$schema !== undefined && value.$schema !== AGENT_PLUGINS_MCP_SCHEMA)
        error("schema_key", `$schema in mcp.json names the Agent Plugins 1.0.0 MCP schema (${AGENT_PLUGINS_MCP_SCHEMA}), or is left out`, MCP_FILE, ["$schema"]);
      const listed = value.mcpServers;
      if (!isObject(listed)) error("mcp_invalid", "mcp.json holds mcpServers: a map of server names to servers", MCP_FILE, listed === undefined ? [] : ["mcpServers"]);
      else
        for (const [key, server] of Object.entries(listed)) {
          const at = ["mcpServers", key];
          if (!DELEGATE_NAME_PATTERN.test(key)) {
            error("mcp_invalid", `MCP server name '${key}' may use only letters, digits, _ and -, up to 64 characters`, MCP_FILE, at, { key: true });
            continue;
          }
          if (!isObject(server)) {
            error("mcp_invalid", "An MCP server is a map with type, url and headers", MCP_FILE, at);
            continue;
          }
          checkKeys(MCP_FILE, server, SERVER_KEYS, at);
          const type = server.type;
          if (type === undefined) {
            error("mcp_type", "type is required: streamable-http or sse (a server with no type is a stdio server, and the Runtime runs remote MCP servers only)", MCP_FILE, at, { key: true });
            continue;
          }
          if (type === "http") {
            error("mcp_type", 'type "http" is Claude Code\'s name; Agent Plugins writes "streamable-http". Fix: change it to "streamable-http"', MCP_FILE, [...at, "type"]);
            continue;
          }
          if (type === "stdio" || type === "ws") {
            error("mcp_type", `type ${type} is not served: the Runtime runs remote MCP servers only (streamable-http or sse)`, MCP_FILE, [...at, "type"]);
            continue;
          }
          if (type !== "streamable-http" && type !== "sse") {
            error("mcp_type", "type is streamable-http or sse", MCP_FILE, [...at, "type"]);
            continue;
          }
          if (typeof server.url !== "string" || server.url === "") {
            error("mcp_invalid", "url is required: the server's own URL", MCP_FILE, server.url === undefined ? at : [...at, "url"]);
            continue;
          }
          if (server.url.includes("${")) {
            error("credential_placement", "${…} names a credential in a header only: a URL is not secret", MCP_FILE, [...at, "url"]);
            continue;
          }
          const headers: Record<string, string> = {};
          let credential: { name: string; header: string; type: "bearer" | "headers"; path: PropertyKey[] } | undefined;
          let headersValid = true;
          if (server.headers !== undefined && !isObject(server.headers)) {
            error("mcp_invalid", "headers is a map of header names to strings", MCP_FILE, [...at, "headers"]);
            headersValid = false;
          }
          for (const [header, raw] of Object.entries(isObject(server.headers) ? server.headers : {})) {
            const path = [...at, "headers", header];
            if (typeof raw !== "string") {
              error("mcp_invalid", "A header's value is a string", MCP_FILE, path);
              headersValid = false;
              continue;
            }
            if (!raw.includes("${")) {
              headers[header] = raw;
              continue;
            }
            const placeholder = /^(Bearer )?\$\{([^}]*)\}$/.exec(raw);
            const named = placeholder?.[2];
            if (!placeholder || named === undefined || raw.indexOf("${") !== raw.lastIndexOf("${")) {
              error("credential_placement", "A header names a credential as its whole value, ${NAME}, or as Bearer ${NAME}", MCP_FILE, path);
              headersValid = false;
              continue;
            }
            if (named.includes(":-") || named.includes(":")) {
              error("credential_default", `\${${named}} has a default: a secret has none, and its value goes to the Agent's vault`, MCP_FILE, path);
              headersValid = false;
              continue;
            }
            if (!TOOL_SECRET_NAME_PATTERN.test(named)) {
              error("credential_name", "A credential's name is 1-64 letters, digits, '.', '_' and '-'", MCP_FILE, path);
              headersValid = false;
              continue;
            }
            if (credential) {
              error("credential_twice", `This server already names ${credential.name} in ${credential.header}: a server authenticates with one credential, in one header`, MCP_FILE, path);
              headersValid = false;
              continue;
            }
            const bearer = placeholder[1] !== undefined;
            if (bearer && header.toLowerCase() !== "authorization") {
              error("credential_placement", "Bearer ${NAME} goes in the Authorization header; another header takes ${NAME} alone", MCP_FILE, path);
              headersValid = false;
              continue;
            }
            credential = { name: named, header, type: bearer ? "bearer" : "headers", path };
          }
          if (!headersValid) continue;
          if (credential) deriveSlot(credential.name, credential.type, server.url, MCP_FILE, credential.path, credential.type === "headers" ? credential.header : undefined);
          servers[key] = {
            name: key,
            type,
            url: server.url,
            ...(Object.keys(headers).length === 0 ? {} : { headers }),
            ...(credential ? { credential: credential.name } : {}),
          };
          origins.push([["harness", "mcpServers", key], { file: MCP_FILE, path: at }]);
        }
    }
  }
  if (front.mcpServers !== undefined) {
    if (!isObject(front.mcpServers)) error("value_invalid", "mcpServers is a map of server names to this agent's settings", AGENT_FILE, ["mcpServers"]);
    else
      for (const [key, settings] of Object.entries(front.mcpServers)) {
        const at = ["mcpServers", key];
        if (!servers[key]) {
          if (byPath.has(MCP_FILE) && !mcpRead) continue;
          const close = suggestion(key, Object.keys(servers));
          error("server_unknown", `No MCP server ${key} is declared in mcp.json.${close ? ` Did you mean '${close}'?` : ""}`, AGENT_FILE, at, { key: true });
          continue;
        }
        if (!isObject(settings)) {
          error("value_invalid", "A server's settings are a map: deferred and tools", AGENT_FILE, at);
          continue;
        }
        checkKeys(AGENT_FILE, settings, SERVER_SETTING_KEYS, at);
        if ("credential" in settings) continue;
        for (const setting of SERVER_SETTING_KEYS)
          if (settings[setting] !== undefined) {
            servers[key]![setting] = settings[setting];
            origins.push([["harness", "mcpServers", key, setting], { file: AGENT_FILE, path: [...at, setting] }]);
          }
      }
  }
  if (Object.keys(servers).length > 0) harness.mcpServers = servers;

  // --- skills/ ---------------------------------------------------------------------------
  const skills: Record<string, Record<string, unknown>> = {};
  const skillFolders = new Map<string, string[]>();
  for (const [path, kind] of kinds)
    if (kind === "skill") {
      const folder = path.split("/")[1]!;
      skillFolders.set(folder, [...(skillFolders.get(folder) ?? []), path]);
    }
  for (const [folder, paths] of skillFolders) {
    const entryPath = `skills/${folder}/${SKILL_ENTRY}`;
    if (!byPath.has(entryPath)) {
      error("skill_invalid", `skills/${folder}/ has no ${SKILL_ENTRY}`, `skills/${folder}/${SKILL_ENTRY}`);
      continue;
    }
    const markdown = readMarkdown(entryPath);
    if (!markdown) continue;
    const data = markdown.data;
    let valid = true;
    for (const key of Object.keys(data)) {
      if (key === "secrets") {
        error(
          "skill_secrets",
          `secrets is not an Agent Skills key: which secrets a skill gets is the agent's choice. Fix: move it to ${AGENT_FILE}'s skills block, as skills: { ${folder}: { secrets: [...] } }`,
          entryPath,
          ["secrets"],
          { key: true },
        );
        valid = false;
      } else if (!SKILL_KEYS.includes(key)) {
        error("unknown_key", unknownKeyMessage(key, SKILL_KEYS), entryPath, [key], { key: true });
        valid = false;
      }
    }
    const skillName = typeof data.name === "string" ? data.name.trim() : "";
    const skillDescription = typeof data.description === "string" ? data.description.trim() : "";
    if (!SKILL_NAME.test(skillName) || skillName.length > 64) {
      error("skill_invalid", "name is required: 1-64 lowercase letters, digits and single hyphens", entryPath, data.name === undefined ? undefined : ["name"]);
      valid = false;
    } else if (skillName !== folder) {
      error("skill_invalid", `name is ${skillName}, and the skill's folder is ${folder}: they must match`, entryPath, ["name"]);
      valid = false;
    }
    if (skillDescription === "" || skillDescription.length > 1024) {
      error("skill_invalid", "description is required, at most 1024 characters", entryPath, data.description === undefined ? undefined : ["description"]);
      valid = false;
    }
    const files: Record<string, string> = {};
    for (const path of paths.sort(compare)) {
      const relative = path.slice(`skills/${folder}/`.length);
      const issue = skillFilePathIssue(relative);
      if (issue) {
        error("path_invalid", `A skill's file path ${issue}`, path);
        valid = false;
        continue;
      }
      files[relative] = `sha256:${byPath.get(path)!.sha256}`;
    }
    if (!valid) continue;
    skills[skillName] = { name: skillName, description: skillDescription, files };
    origins.push([["harness", "skills", skillName], { file: entryPath, path: [] }]);
  }
  if (front.skills !== undefined) {
    if (!isObject(front.skills)) error("value_invalid", "skills is a map of skill names to this agent's settings for them", AGENT_FILE, ["skills"]);
    else
      for (const [key, settings] of Object.entries(front.skills)) {
        const at = ["skills", key];
        if (!skills[key]) {
          if (skillFolders.has(key)) continue;
          const close = suggestion(key, [...skillFolders.keys()]);
          error("skill_unknown", `No skill ${key} is in skills/.${close ? ` Did you mean '${close}'?` : ""}`, AGENT_FILE, at, { key: true });
          continue;
        }
        if (!isObject(settings)) {
          error("value_invalid", "A skill's settings are a map: secrets", AGENT_FILE, at);
          continue;
        }
        checkKeys(AGENT_FILE, settings, ["secrets"], at);
        const secrets = settings.secrets;
        if (secrets === undefined) continue;
        if (!Array.isArray(secrets) || !secrets.every((item) => typeof item === "string" && ENVIRONMENT_NAME_PATTERN.test(item))) {
          error("value_invalid", "secrets is a list of secret slot names, each an environment variable name", AGENT_FILE, [...at, "secrets"]);
          continue;
        }
        if (secrets.length > 0) skills[key]!.secrets = [...new Set(secrets as string[])].sort();
        origins.push([["harness", "skills", key, "secrets"], { file: AGENT_FILE, path: [...at, "secrets"] }]);
      }
  }
  if (Object.keys(skills).length > 0) harness.skills = skills;

  // --- tools/ ----------------------------------------------------------------------------
  const tools: Record<string, unknown>[] = [];
  for (const path of [...kinds].filter(([, kind]) => kind === "tool").map(([path]) => path)) {
    const toolName = path.slice("tools/".length, -".json".length);
    if (!DELEGATE_NAME_PATTERN.test(toolName)) {
      error("tool_invalid", `A tool's name comes from its file name: '${toolName}' may use only letters, digits, _ and -, up to 64 characters`, path);
      continue;
    }
    const value = readJson(path);
    if (!value) continue;
    if ("name" in value) {
      error("tool_invalid", "A tool file takes no name: its file name is the tool's name", path, ["name"], { key: true });
      continue;
    }
    if ("agent" in value) {
      error("not_supported", `A subagent as a tool is not in ${AGENT_FOLDER_COMPILER} yet`, path, ["agent"], { key: true });
      continue;
    }
    if ("$schema" in value) error("schema_key", "A tool file takes no $schema: the path gives the kind", path, ["$schema"], { key: true });
    checkKeys(path, value, [...TOOL_KEYS, "$schema"]);
    if (!isObject(value.http)) {
      error("tool_invalid", "A tool file declares an HTTP tool: http with its url", path, value.http === undefined ? [] : ["http"]);
      continue;
    }
    const tool: Record<string, unknown> = { name: toolName };
    if (value.description !== undefined) tool.description = value.description;
    const input = value.inputSchema === undefined ? undefined : schemaAt(path, ["inputSchema"], value.inputSchema);
    if (value.inputSchema === undefined) error("tool_invalid", "inputSchema is required: the JSON Schema of the tool's input", path, []);
    if (input) tool.inputSchema = input;
    if (value.outputSchema !== undefined) {
      const output = schemaAt(path, ["outputSchema"], value.outputSchema);
      if (output) tool.outputSchema = output;
    }
    tool.http = value.http;
    if (value.approval !== undefined) tool.approval = value.approval;
    const credential = value.http.credential;
    if (typeof credential === "string" && typeof value.http.url === "string")
      deriveSlot(credential, "bearer", value.http.url, path, ["http", "credential"]);
    origins.push([["harness", "tools", tools.length], { file: path, path: [] }]);
    tools.push(tool);
  }
  if (tools.length > 0) harness.tools = tools;

  // --- triggers/ -------------------------------------------------------------------------
  const triggers: Record<string, unknown> = {};
  for (const path of [...kinds].filter(([, kind]) => kind === "trigger").map(([path]) => path)) {
    const id = path.slice("triggers/".length, -".md".length);
    const markdown = readMarkdown(path);
    if (!markdown) continue;
    if (!markdown.hasFrontmatter) {
      error("frontmatter_missing", "A trigger opens with frontmatter: schedule, at or webhook, and session", path, undefined, { at: { line: 1, column: 1 } });
      continue;
    }
    checkKeys(path, markdown.data, TRIGGER_KEYS);
    const trigger = { ...markdown.data, prompt: trimBlankLines(markdown.body) };
    if (isObject(runtime?.triggers) && id in runtime.triggers) {
      error("trigger_twice", `Trigger ${id} is declared in runtime.json and in ${path}: keep one`, path);
      continue;
    }
    triggers[id] = trigger;
    origins.push([["runtime", "triggers", id], { file: path, path: [] }]);
  }

  // --- files/ ----------------------------------------------------------------------------
  const seeded: Record<string, string> = {};
  for (const [path, kind] of kinds) if (kind === "file") seeded[path.slice("files/".length)] = `sha256:${byPath.get(path)!.sha256}`;

  // --- The runtime section -----------------------------------------------------------------
  const needsRuntime = derivedSlots.size > 0 || Object.keys(triggers).length > 0 || Object.keys(seeded).length > 0;
  if (!runtime && needsRuntime) runtime = { kind: "none" };
  if (runtime) {
    if (derivedSlots.size > 0) {
      const declared = isObject(runtime.secrets) ? runtime.secrets : {};
      runtime.secrets = { ...declared, ...Object.fromEntries([...derivedSlots].map(([key, { slot }]) => [key, slot])) };
      for (const [key, derived] of derivedSlots) origins.push([["runtime", "secrets", key], { file: derived.file, path: derived.path }]);
    }
    if (Object.keys(triggers).length > 0) runtime.triggers = { ...(isObject(runtime.triggers) ? runtime.triggers : {}), ...triggers };
    if (Object.keys(seeded).length > 0) {
      runtime.files = [...(Array.isArray(runtime.files) ? runtime.files : []), { path: WORKSPACE, files: seeded }];
      origins.push([["runtime", "files"], { file: byPath.has(RUNTIME_FILE) ? RUNTIME_FILE : "files/", path: ["files"] }]);
    }
  }

  // --- Every field checked as the Runtime checks the manifest ------------------------------
  if (diagnostics.some((item) => item.severity === "error") || name === undefined || description === undefined)
    return finish(diagnostics);
  const document = {
    manifestSchemaVersion: AGENT_MANIFEST_V8_SCHEMA_VERSION,
    name,
    description,
    ...(metadata === undefined ? {} : { metadata }),
    harness,
    ...(runtime === undefined ? {} : { runtime }),
  };
  origins.push([["name"], { file: AGENT_FILE, path: ["name"] }], [["description"], { file: AGENT_FILE, path: ["description"] }], [["metadata"], { file: AGENT_FILE, path: ["metadata"] }]);
  // Triggers from triggers/ are checked against their own schema first, with the file's lines.
  for (const [id, trigger] of Object.entries(triggers)) {
    const result = TriggerSchema.safeParse(trigger);
    if (result.success) continue;
    for (const issue of result.error.issues) issueDiagnostic(issue, ["runtime", "triggers", id], `triggers/${id}.md`, issue.path);
  }
  const checked = AgentManifestV8Schema.safeParse(document);
  if (!checked.success)
    for (const issue of checked.error.issues) {
      if (issue.path[0] === "runtime" && issue.path[1] === "triggers" && typeof issue.path[2] === "string" && issue.path[2] in triggers) continue;
      const origin = originOf(origins, issue.path);
      issueDiagnostic(issue, [], origin?.file, origin ? [...origin.origin.path, ...issue.path.slice(origin.prefix)] : undefined);
    }
  if (diagnostics.some((item) => item.severity === "error")) return finish(diagnostics);
  return finish(diagnostics, checked.success ? (checked.data as AgentManifestV8) : undefined);

  function issueDiagnostic(issue: z.core.$ZodIssue, prefix: readonly PropertyKey[], file: string | undefined, path: readonly PropertyKey[] | undefined) {
    const pointer = pointerOf([...prefix, ...issue.path]);
    if (issue.code === "unrecognized_keys") {
      const known = knownKeys([...prefix, ...issue.path]);
      for (const key of issue.keys)
        error("unknown_key", known.length ? unknownKeyMessage(key, known) : `Unknown key '${key}'`, file, path ? [...path, key] : undefined, { key: true, pointer: pointerOf([...prefix, ...issue.path, key]) });
      return;
    }
    // The field as the file names it, or as the manifest does when no file holds it.
    const shown = file && path ? path : [...prefix, ...issue.path];
    const field = shown.length ? `${shown.map(String).join(".")}: ` : "";
    error("schema_invalid", `${field}${issue.message}`, file, path, { pointer });
  }
}

function finish(diagnostics: AgentFolderDiagnostic[], manifest?: AgentManifestV8): CompiledAgentFolder {
  const order = { error: 0, warning: 1, info: 2, note: 3 } as const;
  const sorted = [...diagnostics].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      compare(a.file ?? "", b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
  return { ...(manifest === undefined ? {} : { manifest }), diagnostics: sorted, compiler: AGENT_FOLDER_COMPILER };
}

/** The closest recorded position for `path` in `file`: the field, else its nearest parent. */
function locate(file: ParsedFile | undefined, path: readonly PropertyKey[]): Located | undefined {
  if (!file) return undefined;
  for (let length = path.length; length >= 0; length--) {
    const found = file.positions.get(pointerOf(path.slice(0, length)));
    if (found) return found;
  }
  return undefined;
}

/** The origin recorded for the longest prefix of a manifest path. */
function originOf(origins: readonly [readonly PropertyKey[], Origin][], path: readonly PropertyKey[]): { file: string; origin: Origin; prefix: number } | undefined {
  let best: { file: string; origin: Origin; prefix: number } | undefined;
  for (const [prefix, origin] of origins) {
    if (prefix.length > path.length || (best && prefix.length <= best.prefix)) continue;
    if (prefix.every((part, index) => String(part) === String(path[index]))) best = { file: origin.file, origin, prefix: prefix.length };
  }
  return best;
}

/** The keys an object at `path` of `value` holds, for a "did you mean". */
function knownKeys(path: readonly PropertyKey[]): string[] {
  let schema: unknown = AgentManifestV8Schema;
  for (const part of path) {
    schema = descend(schema, part);
    if (!schema) return [];
  }
  const shape = shapeOf(schema);
  return shape ? Object.keys(shape) : [];
}

type AnySchema = { _zod?: { def?: Record<string, unknown> } };

function defOf(schema: unknown): Record<string, unknown> | undefined {
  return (schema as AnySchema)?._zod?.def;
}

function unwrap(schema: unknown): unknown {
  for (let depth = 0; depth < 20; depth++) {
    const def = defOf(schema);
    if (!def) return schema;
    if (def.type === "optional" || def.type === "nullable" || def.type === "default" || def.type === "readonly" || def.type === "catch")
      schema = def.innerType;
    else if (def.type === "pipe") schema = def.in;
    else if (def.type === "lazy") schema = (def.getter as () => unknown)();
    else return schema;
  }
  return schema;
}

function shapeOf(schema: unknown): Record<string, unknown> | undefined {
  const def = defOf(unwrap(schema));
  return def?.type === "object" ? (def.shape as Record<string, unknown>) : undefined;
}

function descend(schema: unknown, part: PropertyKey): unknown {
  const inner = unwrap(schema);
  const def = defOf(inner);
  if (!def) return undefined;
  if (def.type === "object") return (def.shape as Record<string, unknown>)[String(part)];
  if (def.type === "array") return def.element;
  if (def.type === "record") return def.valueType;
  if (def.type === "union")
    for (const option of def.options as unknown[]) {
      const found = descend(option, part);
      if (found) return found;
    }
  return undefined;
}

/** `text` without its leading and trailing blank lines; nothing else is touched. */
function trimBlankLines(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}
