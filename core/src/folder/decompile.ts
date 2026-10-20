/**
 * The agent folder of a manifest (track T7, D80): `folderOfManifest` is `compileAgentFolder` run
 * backwards. It writes the folder that compiles back to the same agent manifest v8, for an agent
 * saved as JSON or from TypeScript (`nylorun export --folder`) and for the three-file format
 * (`nylorun migrate folder`). Like the compiler it is pure: no file system, clock or network.
 *
 * Each manifest field goes where the compiler reads it:
 *
 * - `name`, `description`, `metadata`, `harness.id`, `memory`, `loop`, and this agent's server and
 *   skill settings: `AGENT.md` frontmatter. `harness.outputSchema`: `output.schema.json`, named by
 *   `outputSchema`.
 * - `harness.instructions`: the first as `AGENT.md`'s body, each other as
 *   `instructions/NN-<slug>.md`, zero-padded so path order and natural order agree.
 * - HTTP tools: `tools/<name>.json`, their schemas inline.
 * - MCP servers: `mcp.json` in Agent Plugins syntax; a server's `credential` is
 *   `Authorization: Bearer ${SLOT}` for a `bearer` slot, `<header>: ${SLOT}` for a `headers` one.
 * - `runtime`: `runtime.json`, without what the folder gives on its own: each trigger that is a
 *   `triggers/<id>.md`, and each secret slot the compiler derives identically from a credential.
 *   With nothing left but kind `none`, there is no `runtime.json`.
 * - `runtime.files` stay in `runtime.json` by hash: the Runtime holds the bytes. Given the bytes
 *   (`options.files`), a last `/workspace` entry becomes `files/`.
 * - Skills: the manifest has their files by hash only. Given the bytes (`options.files`, by
 *   `sha256:<hex>`), each skill is written as its folder; a `SKILL.md` that still says `secrets`
 *   loses that key, which `AGENT.md`'s `skills` block holds now (D80), so its hash changes.
 *   Without them, a placeholder `SKILL.md` stands in and a note lists the files to copy in.
 *
 * Not written yet: flows (`kind: "workflow"`), subagents as tools (`tools[].agent`) and plugin
 * labels, which `agent-folder/1` does not compile yet. A flow gives no files and a note; the rest
 * is left out with a note. Every note says what differs, and `exact` says whether the folder,
 * compiled, gives the same manifest (`hashManifest`): it is checked by compiling it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { stringify } from "yaml";
import type { AgentManifestV8, WorkflowHarnessSection } from "../contracts.js";
import { canonical } from "../utils/canonical.js";
import { hashManifest } from "../utils/hash.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderEntry } from "./compile.js";
import { parseMarkdown } from "./frontmatter.js";

export interface FolderOfManifestOptions {
  /**
   * The bytes behind the manifest's file hashes (`sha256:<hex>`): its skills' files and its
   * `runtime.files`. Without them a skill is a placeholder and `runtime.files` stay by hash.
   */
  readonly files?: ReadonlyMap<string, Uint8Array>;
}

export interface FolderOfManifest {
  /** Each file of the folder by its `/`-separated path: text, or the bytes of a skill's file. */
  readonly files: Map<string, Uint8Array | string>;
  /** What the folder leaves out or writes differently from the manifest, as a person reads it. */
  readonly notes: string[];
  /** Whether the folder compiles back to a manifest with the same hash. */
  readonly exact: boolean;
}

const AGENT_FILE = "AGENT.md";
const OUTPUT_SCHEMA_FILE = "output.schema.json";
const WORKSPACE = "/workspace";
const TRIGGER_FILE_KEYS = ["schedule", "timezone", "at", "webhook", "session", "prompt"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Frontmatter as `parseMarkdown` reads it back: YAML 1.2, core schema, no anchors or aliases. */
function frontmatter(data: Record<string, unknown>): string {
  return stringify(data, { version: "1.2", schema: "core", aliasDuplicateObjects: false, lineWidth: 0 });
}

/** `text` as the compiler keeps a Markdown file's prose: without leading and trailing blank lines. */
function trimBlankLines(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}

/** Whether the compiler reads `text` back as written from a Markdown body. */
const keepsProse = (text: string) => text !== "" && !text.startsWith("﻿") && trimBlankLines(text) === text;

/** A short file name part from an instruction's first line: `## Tone of voice` → `tone-of-voice`. */
function slugOf(text: string): string {
  const line = text.split("\n").find((item) => item.trim() !== "") ?? "";
  const words = line
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words.slice(0, 5)) {
    if (slug.length + word.length + 1 > 40) break;
    slug = slug ? `${slug}-${word}` : word;
  }
  return slug;
}

/** The value of a `headers` slot's description the compiler writes: the header the value sets. */
const headerOfSlot = (slot: unknown): string | undefined =>
  isObject(slot) && typeof slot.description === "string" ? /^Sets the (\S+) header$/.exec(slot.description)?.[1] : undefined;

/** One place a credential is used: the slot the compiler would derive for it there. */
interface CredentialUse {
  readonly type: "bearer" | "headers";
  readonly url: string;
  readonly header?: string;
}

const derivedSlot = (use: CredentialUse) => ({
  type: use.type,
  url: use.url,
  required: true,
  ...(use.type === "headers" && use.header ? { description: `Sets the ${use.header} header` } : {}),
});

/** Writes the agent folder of `manifest`; see the module comment for what it covers. */
export function folderOfManifest(manifest: AgentManifestV8, options: FolderOfManifestOptions = {}): FolderOfManifest {
  const files = new Map<string, Uint8Array | string>();
  const notes: string[] = [];
  if (isWorkflow(manifest.harness)) {
    notes.push(...flowNotes(manifest.harness));
    return { files, notes, exact: false };
  }
  const harness = manifest.harness;
  const bytesOf = (hash: string) => options.files?.get(hash);
  const front: Record<string, unknown> = { name: manifest.name };

  // --- name, description, metadata --------------------------------------------------------
  const description = manifest.description;
  if (description === undefined || description.trim() === "") {
    front.description = `What ${manifest.name} does, in a sentence.`;
    notes.push(`The manifest has no description, which AGENT.md needs: write one there (a placeholder stands in).`);
  } else {
    if (description.trim() !== description) notes.push("The description loses its leading and trailing spaces: AGENT.md's is trimmed.");
    front.description = description;
  }
  if (harness.id !== undefined) front.harness = harness.id;
  if (harness.outputSchema !== undefined) {
    if (isObject(harness.outputSchema)) {
      front.outputSchema = `./${OUTPUT_SCHEMA_FILE}`;
      files.set(OUTPUT_SCHEMA_FILE, json(harness.outputSchema));
    } else notes.push("harness.outputSchema is not a JSON Schema object, which a folder names by file: it is left out.");
  }

  // --- MCP servers -------------------------------------------------------------------------
  const secrets = isObject(manifest.runtime?.secrets) ? manifest.runtime.secrets : {};
  const uses = new Map<string, CredentialUse[]>();
  const use = (credential: string, item: CredentialUse) => uses.set(credential, [...(uses.get(credential) ?? []), item]);
  const servers: Record<string, Record<string, unknown>> = {};
  const serverSettings: Record<string, Record<string, unknown>> = {};
  for (const [key, server] of Object.entries(harness.mcpServers ?? {})) {
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    if (Object.values(headers).some((value) => value.includes("${"))) {
      notes.push(`MCP server ${key}: a header holds \${…}, which mcp.json reads as a credential: it is left out.`);
      continue;
    }
    if (server.url.includes("${")) {
      notes.push(`MCP server ${key}: its url holds \${…}, which mcp.json refuses: it is left out.`);
      continue;
    }
    if (server.credential !== undefined) {
      const slot = secrets[server.credential];
      const taken = (name: string) => Object.keys(headers).some((header) => header.toLowerCase() === name.toLowerCase());
      const wanted = headerOfSlot(slot);
      if (isObject(slot) && slot.type === "headers") {
        const header = [wanted, "X-Api-Key", "X-Credential"].find((name) => name !== undefined && !taken(name)) ?? `X-${server.credential}`;
        headers[header] = `\${${server.credential}}`;
        use(server.credential, { type: "headers", url: server.url, header });
      } else if (!taken("Authorization")) {
        headers.Authorization = `Bearer \${${server.credential}}`;
        use(server.credential, { type: "bearer", url: server.url });
      } else {
        const header = ["X-Credential", "X-Api-Key"].find((name) => !taken(name)) ?? `X-${server.credential}`;
        headers[header] = `\${${server.credential}}`;
        use(server.credential, { type: "headers", url: server.url, header });
      }
    }
    servers[key] = {
      type: server.type,
      url: server.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
    const settings: Record<string, unknown> = {};
    if (server.deferred !== undefined) settings.deferred = server.deferred;
    if (server.tools !== undefined) settings.tools = server.tools;
    if (Object.keys(settings).length > 0) serverSettings[key] = settings;
    if (server.plugin !== undefined)
      notes.push(`MCP server ${key} came from plugin ${server.plugin.name}; plugins/ is not in agent-folder/1 yet, so it is written as the folder's own server.`);
    if (server.headers !== undefined && Object.keys(server.headers).length === 0)
      notes.push(`MCP server ${key}: its empty headers map is left out.`);
  }
  if (Object.keys(servers).length > 0) files.set("mcp.json", json({ mcpServers: servers }));
  if (Object.keys(serverSettings).length > 0) front.mcpServers = serverSettings;

  // --- Skills ------------------------------------------------------------------------------
  const skillSettings: Record<string, Record<string, unknown>> = {};
  for (const [key, skill] of Object.entries(harness.skills ?? {})) {
    if (skill.plugin !== undefined)
      notes.push(`Skill ${key} came from plugin ${skill.plugin.name}; plugins/ is not in agent-folder/1 yet, so it is written as the folder's own skill.`);
    if (skill.secrets !== undefined) {
      skillSettings[key] = { secrets: [...skill.secrets] };
      const sorted = [...new Set(skill.secrets)].sort();
      if (!same(sorted, skill.secrets))
        notes.push(`Skill ${key}: its secrets are sorted, each once${sorted.length === 0 ? ", and an empty list is left out" : ""}.`);
    }
    const missing: string[] = [];
    for (const [path, hash] of Object.entries(skill.files)) {
      const bytes = bytesOf(hash);
      if (!bytes) {
        missing.push(`${path} (${hash})`);
        continue;
      }
      if (path !== "SKILL.md") {
        files.set(`skills/${key}/${path}`, bytes);
        continue;
      }
      const moved = withoutSkillSecrets(bytes);
      if (moved === undefined) files.set(`skills/${key}/${path}`, bytes);
      else {
        files.set(`skills/${key}/${path}`, moved);
        notes.push(`skills/${key}/SKILL.md: secrets moved to AGENT.md's skills block (D80), so the file and its hash change.`);
      }
    }
    if (missing.length > 0) {
      if (!files.has(`skills/${key}/SKILL.md`))
        files.set(
          `skills/${key}/SKILL.md`,
          `---\n${frontmatter({ name: skill.name, description: skill.description })}---\nA placeholder: the saved manifest names this skill's files by hash only. Copy the skill's folder over this one.\n`,
        );
      notes.push(`Skill ${key}: the manifest has its files by hash only, so copy the skill's folder into skills/${key}/. Missing: ${missing.join(", ")}.`);
    }
  }
  if (Object.keys(skillSettings).length > 0) front.skills = skillSettings;
  if (harness.skills !== undefined && Object.keys(harness.skills).length === 0) notes.push("harness.skills is an empty map: it is left out.");

  if (harness.memory !== undefined) front.memory = harness.memory;
  if (harness.loop !== undefined) {
    if (isObject(harness.loop)) front.loop = harness.loop;
    else notes.push("harness.loop is not a map, which AGENT.md needs: it is left out.");
  }
  if (manifest.metadata !== undefined) {
    if (isObject(manifest.metadata)) front.metadata = manifest.metadata;
    else notes.push("metadata is not a map, which AGENT.md needs: it is left out.");
  }
  if (harness.plugins !== undefined && harness.plugins.length > 0)
    notes.push(`harness.plugins (${harness.plugins.map((plugin) => plugin.name).join(", ")}) is left out: plugins/ is not in agent-folder/1 yet.`);

  // --- Tools -------------------------------------------------------------------------------
  const tools = harness.tools ?? [];
  const written: string[] = [];
  for (const tool of tools) {
    if (tool.agent !== undefined) {
      notes.push(`Tool ${tool.name} is a subagent: subagents are exported as agents/${tool.name}/ once the compiler supports them. It is left out.`);
      continue;
    }
    if (tool.http === undefined) {
      notes.push(`Tool ${tool.name} is neither an HTTP tool nor a subagent, which a folder cannot write: it is left out.`);
      continue;
    }
    const file: Record<string, unknown> = {};
    if (tool.description !== undefined) file.description = tool.description;
    file.inputSchema = tool.inputSchema;
    if (tool.outputSchema !== undefined) file.outputSchema = tool.outputSchema;
    file.http = tool.http;
    if (tool.approval !== undefined)
      notes.push(`Tool ${tool.name} has approval "${tool.approval}", which a folder does not take: a person approves a call through the Tenant's tool policy (a rule with "effect": "ask"). It is left out.`);
    files.set(`tools/${tool.name}.json`, json(file));
    written.push(tool.name);
    if (tool.http.credential !== undefined) use(tool.http.credential, { type: "bearer", url: tool.http.url });
  }
  const byPath = [...written].sort((a, b) => compare(`tools/${a}.json`, `tools/${b}.json`));
  if (!same(byPath, written)) notes.push(`harness.tools are listed in file name order (${byPath.join(", ")}), as tools/ gives them.`);
  if (harness.tools !== undefined && harness.tools.length === 0) notes.push("harness.tools is an empty list: it is left out.");

  // --- Instructions ------------------------------------------------------------------------
  const instructions = harness.instructions ?? [];
  if (harness.instructions !== undefined && instructions.length === 0) notes.push("harness.instructions is an empty list: it is left out.");
  let body = "";
  const width = Math.max(2, String(instructions.length - 1).length);
  instructions.forEach((text, index) => {
    const prose = trimBlankLines(text.replace(/^﻿/, ""));
    if (!keepsProse(text))
      notes.push(
        prose === ""
          ? `Instruction ${index + 1} is blank, and a blank file gives no instruction: it is left out.`
          : `Instruction ${index + 1} loses its leading and trailing blank lines${text.includes("\r\n") ? " and its CRLF line ends" : ""}, as Markdown files are read.`,
      );
    if (prose === "") return;
    if (index === 0 && body === "") {
      body = prose;
      return;
    }
    const slug = slugOf(prose);
    files.set(`instructions/${String(index).padStart(width, "0")}${slug ? `-${slug}` : ""}.md`, `${prose}\n`);
  });

  // --- Triggers ----------------------------------------------------------------------------
  const runtime = manifest.runtime;
  const rest: Record<string, unknown> | undefined = runtime === undefined ? undefined : { ...runtime };
  let moved = false;
  if (rest && isObject(runtime!.triggers)) {
    const kept: Record<string, unknown> = {};
    const folded = new Set<string>();
    for (const [id, trigger] of Object.entries(runtime!.triggers)) {
      const asFile =
        Object.keys(trigger).every((key) => TRIGGER_FILE_KEYS.includes(key)) &&
        keepsProse(trigger.prompt) &&
        !folded.has(id.toLowerCase());
      if (!asFile) {
        kept[id] = trigger;
        continue;
      }
      folded.add(id.toLowerCase());
      const { prompt, ...settings } = trigger;
      files.set(`triggers/${id}.md`, `---\n${frontmatter(settings)}---\n${prompt}\n`);
      moved = true;
    }
    if (Object.keys(kept).length > 0) rest.triggers = kept;
    else if (moved) delete rest.triggers;
  }

  // --- Secret slots the compiler derives ---------------------------------------------------
  for (const [credential, places] of uses) {
    const slot = secrets[credential];
    if (slot === undefined) {
      notes.push(`${credential} has no slot in runtime.secrets: the folder derives one for ${places[0]!.url}.`);
      continue;
    }
    const first = places[0]!;
    const agree = places.every((place) => place.type === first.type && place.url === first.url);
    if (agree && same(slot, derivedSlot(first)) && rest && isObject(rest.secrets)) {
      const { [credential]: _, ...others } = rest.secrets;
      rest.secrets = others;
      moved = true;
    }
  }
  if (rest && isObject(rest.secrets) && Object.keys(rest.secrets).length === 0 && isObject(runtime!.secrets) && Object.keys(runtime!.secrets).length > 0)
    delete rest.secrets;

  // --- files/ ------------------------------------------------------------------------------
  if (rest && Array.isArray(rest.files) && rest.files.length > 0) {
    const last = rest.files.at(-1) as Record<string, unknown>;
    const seeded = isObject(last.files) ? (last.files as Record<string, string>) : undefined;
    if (
      last.path === WORKSPACE &&
      Object.keys(last).length === 2 &&
      seeded &&
      Object.values(seeded).every((hash) => bytesOf(hash) !== undefined)
    ) {
      for (const [path, hash] of Object.entries(seeded)) files.set(`files/${path}`, bytesOf(hash)!);
      rest.files = rest.files.slice(0, -1);
      if ((rest.files as unknown[]).length === 0) delete rest.files;
      moved = true;
    }
  }

  // --- runtime.json ------------------------------------------------------------------------
  // The compiler makes kind `none` itself for a folder with derived slots, triggers or files/.
  if (rest && !(moved && same(rest, { kind: "none" }))) files.set("runtime.json", json(rest));

  // --- AGENT.md ----------------------------------------------------------------------------
  files.set(AGENT_FILE, `---\n${frontmatter(front)}---\n${body === "" ? "" : `${body}\n`}`);

  const sorted = new Map([...files].sort(([a], [b]) => compare(a, b)));
  const exact = verify(manifest, sorted, notes);
  return { files: sorted, notes, exact };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function isWorkflow(harness: AgentManifestV8["harness"]): harness is WorkflowHarnessSection {
  return isObject(harness) && (harness as { kind?: unknown }).kind === "workflow";
}

/**
 * A flow, until the compiler takes `flow.json` (design §3.8): `AGENT.md` with no body and
 * `inputSchema`, `flow.json` with v3's node tree, one flat `agents/<id>/` namespace per flow root,
 * each agent written as an agent folder (this module, without `runtime.json` or `triggers/`),
 * and a sub-flow as an `agents/<id>/` with its own `flow.json` over the same namespace.
 */
function flowNotes(harness: WorkflowHarnessSection): string[] {
  return [
    `This manifest is a flow (harness.kind "workflow", agents ${Object.keys(harness.agents).join(", ")}): flows are exported once the compiler supports them (flow.json and agents/). Nothing was written.`,
  ];
}

/** A `SKILL.md` without its frontmatter `secrets` key, or undefined when it has none. */
function withoutSkillSecrets(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const parsed = parseMarkdown(text);
  if (!parsed.ok || !parsed.hasFrontmatter || !("secrets" in parsed.data)) return undefined;
  const { secrets: _, ...data } = parsed.data;
  return `---\n${frontmatter(data)}---\n${parsed.body}`;
}

/** Compiles the folder and compares: a note for each way it differs that no note explains yet. */
function verify(manifest: AgentManifestV8, files: ReadonlyMap<string, Uint8Array | string>, notes: string[]): boolean {
  const encoder = new TextEncoder();
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of files) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  const compiled = compileAgentFolder({
    entries,
    files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])),
    name: manifest.name,
  });
  if (!compiled.manifest) {
    for (const item of compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"))
      notes.push(`The folder does not compile: ${item.file ? `${item.file}: ` : ""}${item.message}`);
    return false;
  }
  if (hashManifest(compiled.manifest as never) === hashManifest(manifest as never)) return true;
  if (notes.length === 0) {
    const where = firstDifference(manifest, compiled.manifest);
    notes.push(`The folder compiles to a different manifest${where ? `, first at ${where}` : ""}.`);
  }
  return false;
}

/** The first path where two JSON values differ, as `harness.tools.0.http`. */
function firstDifference(a: unknown, b: unknown, path: string[] = []): string | undefined {
  if (same(a, b)) return undefined;
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      if (!same(a[key], b[key])) return firstDifference(a[key], b[key], [...path, key]) ?? [...path, key].join(".");
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    for (let index = 0; index < a.length; index++)
      if (!same(a[index], b[index])) return firstDifference(a[index], b[index], [...path, String(index)]);
  return path.join(".") || undefined;
}

