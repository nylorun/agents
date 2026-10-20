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
 * - Subagents (a tool with `agent`): `agents/<name>/`, an agent folder of the embedded agent
 *   manifest v7 (or a flow, workflow manifest v3), as the compiler reads one (design §3.3).
 * - Flows (`kind: "workflow"`, design §3.8): `AGENT.md` with no body and `inputSchema`
 *   (`input.schema.json`), `flow.json` with v3's node tree naming agents by id and tools by file
 *   name, and one flat `agents/<id>/` namespace at the flow root for every agent of the flow and
 *   of its sub-flows. A sub-flow is an `agents/<id>/` with its own `flow.json` over the same
 *   namespace. A tool stage, and an HTTP verifier (`{ http }`, `{ tool }` in a folder), is
 *   `tools/<name>.json` beside the `flow.json` that names it. Schemas are written inline or
 *   beside the agent that uses them: shared schema files are not recovered.
 * - MCP servers: `mcp.json` in Agent Plugins syntax; a server's `credential` is
 *   `Authorization: Bearer ${SLOT}` for a `bearer` slot, `<header>: ${SLOT}` for a `headers` one.
 * - `runtime`: `runtime.json`, without what the folder gives on its own: each trigger that is a
 *   `triggers/<id>.md`, and each secret slot the compiler derives identically from a credential,
 *   in the folder or in any folder inside it. With nothing left but kind `none`, there is no
 *   `runtime.json`.
 * - `runtime.files` stay in `runtime.json` by hash: the Runtime holds the bytes. Given the bytes
 *   (`options.files`), a last `/workspace` entry becomes `files/`.
 * - Skills: the manifest has their files by hash only. Given the bytes (`options.files`, by
 *   `sha256:<hex>`), each skill is written as its folder; a `SKILL.md` that still says `secrets`
 *   loses that key, which `AGENT.md`'s `skills` block holds now (D80), so its hash changes.
 *   Without them, a placeholder `SKILL.md` stands in and a note lists the files to copy in.
 *
 * What a folder cannot say is left out or written another way, with a note: an embedded agent's
 * display `name` (in a folder an agent's name is its id), plugin labels, a tool's approval, two
 * different agents of one id in a flow's namespace. Every note says what differs, and `exact`
 * says whether the folder, compiled, gives the same manifest (`hashManifest`): it is checked by
 * compiling it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { stringify } from "yaml";
import type { AgentManifest, AgentManifestV8, WorkflowManifest } from "../contracts.js";
import { DELEGATE_INPUT_SCHEMA } from "../definition/delegate.js";
import type { WorkflowNode } from "../types/workflow.js";
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
const FLOW_FILE = "flow.json";
const OUTPUT_SCHEMA_FILE = "output.schema.json";
const INPUT_SCHEMA_FILE = "input.schema.json";
const WORKSPACE = "/workspace";
const TRIGGER_FILE_KEYS = ["schedule", "timezone", "at", "webhook", "session", "prompt"];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

/** What the folders being written share: the files, the notes, and where credentials are used. */
interface Writer {
  readonly files: Map<string, Uint8Array | string>;
  readonly notes: string[];
  /** The places each credential is used, in any folder: the root derives every slot. */
  readonly uses: Map<string, CredentialUse[]>;
  /** The root's `runtime.secrets`. */
  readonly secrets: Record<string, unknown>;
  readonly bytesOf: (hash: string) => Uint8Array | undefined;
}

/**
 * One folder being written: its path prefix (`""` for the root, `agents/<id>/` inside it), and
 * what it is to the folder that holds it: the uploaded folder, a subagent or a stage of a flow.
 */
interface Place {
  readonly prefix: string;
  readonly role: "root" | "subagent" | "stage";
}

/** A flow root's one flat `agents/`: the agents written there, each once, by id. */
interface Namespace {
  readonly dir: string;
  readonly members: Map<string, string>;
}

/** What `AGENT.md` names an agent by: its manifest's name (or embedded id), description, metadata. */
interface Identity {
  readonly name: string;
  readonly description?: string;
  readonly metadata?: unknown;
}

/** The harness fields an agent folder writes: an agent manifest v8's, or an embedded v7's. */
interface AgentFields {
  readonly id?: string;
  readonly instructions?: readonly string[];
  readonly tools?: readonly Json[];
  readonly skills?: Readonly<Record<string, Json>>;
  readonly mcpServers?: Readonly<Record<string, Json>>;
  readonly plugins?: readonly { name: string }[];
  readonly outputSchema?: unknown;
  readonly memory?: unknown;
  readonly loop?: unknown;
}

/** The harness fields a flow folder writes: a v8 workflow harness's, or an embedded v3's. */
interface FlowFields {
  readonly id?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly root: WorkflowNode;
  readonly agents: Readonly<Record<string, AgentManifest | WorkflowManifest>>;
  readonly plugins?: readonly { name: string }[];
  readonly loop?: unknown;
}

/** Writes the agent folder of `manifest`; see the module comment for what it covers. */
export function folderOfManifest(manifest: AgentManifestV8, options: FolderOfManifestOptions = {}): FolderOfManifest {
  const writer: Writer = {
    files: new Map(),
    notes: [],
    uses: new Map(),
    secrets: isObject(manifest.runtime?.secrets) ? manifest.runtime.secrets : {},
    bytesOf: (hash) => options.files?.get(hash),
  };
  const identity: Identity = { name: manifest.name, description: manifest.description, metadata: manifest.metadata };
  const root: Place = { prefix: "", role: "root" };
  if (isWorkflow(manifest.harness)) writeFlow(writer, root, identity, manifest.harness as unknown as FlowFields);
  else writeAgent(writer, root, identity, manifest.harness as AgentFields);
  writeRuntime(writer, manifest);

  const sorted = new Map([...writer.files].sort(([a], [b]) => compare(a, b)));
  const exact = verify(manifest, sorted, writer.notes);
  return { files: sorted, notes: writer.notes, exact };
}

/** A note about a folder: one inside the root names its path first. */
const noteAt = (writer: Writer, place: Place, text: string) => writer.notes.push(place.prefix === "" ? text : `${place.prefix}: ${text}`);

const useCredential = (writer: Writer, credential: string, use: CredentialUse) =>
  writer.uses.set(credential, [...(writer.uses.get(credential) ?? []), use]);

/** `AGENT.md`'s name and description, with a placeholder for a missing description. */
function identityFront(writer: Writer, place: Place, identity: Identity): Record<string, unknown> {
  const front: Record<string, unknown> = { name: identity.name };
  const description = identity.description;
  if (description === undefined || description.trim() === "") {
    front.description = `What ${identity.name} does, in a sentence.`;
    noteAt(writer, place, `The ${place.role === "root" ? "manifest" : "agent"} has no description, which AGENT.md needs: write one there (a placeholder stands in).`);
  } else {
    if (description.trim() !== description) noteAt(writer, place, "The description loses its leading and trailing spaces: AGENT.md's is trimmed.");
    front.description = description;
  }
  return front;
}

/** A JSON Schema field as a file beside `AGENT.md`, named in its frontmatter. */
function schemaFile(writer: Writer, place: Place, front: Record<string, unknown>, key: string, file: string, schema: unknown, field: string): void {
  if (schema === undefined) return;
  if (!isObject(schema)) {
    noteAt(writer, place, `${field} is not a JSON Schema object, which a folder names by file: it is left out.`);
    return;
  }
  front[key] = `./${file}`;
  writer.files.set(place.prefix + file, json(schema));
}

/** An agent folder: `AGENT.md`, `mcp.json`, `skills/`, `tools/`, `agents/` and `instructions/`. */
function writeAgent(writer: Writer, place: Place, identity: Identity, harness: AgentFields): void {
  const { files } = writer;
  const at = place.prefix;
  const root = place.role === "root";
  const note = (text: string) => noteAt(writer, place, text);
  const front = identityFront(writer, place, identity);
  if (harness.id !== undefined) front.harness = harness.id;
  schemaFile(writer, place, front, "outputSchema", OUTPUT_SCHEMA_FILE, harness.outputSchema, "harness.outputSchema");

  // --- MCP servers -------------------------------------------------------------------------
  const secrets = writer.secrets;
  const servers: Record<string, Record<string, unknown>> = {};
  const serverSettings: Record<string, Record<string, unknown>> = {};
  for (const [key, server] of Object.entries(harness.mcpServers ?? {})) {
    const url = String(server.url);
    const headers: Record<string, string> = { ...((server.headers as Record<string, string> | undefined) ?? {}) };
    if (Object.values(headers).some((value) => value.includes("${"))) {
      note(`MCP server ${key}: a header holds \${…}, which mcp.json reads as a credential: it is left out.`);
      continue;
    }
    if (url.includes("${")) {
      note(`MCP server ${key}: its url holds \${…}, which mcp.json refuses: it is left out.`);
      continue;
    }
    const credential = typeof server.credential === "string" ? server.credential : undefined;
    if (credential !== undefined && !root)
      note(`MCP server ${key} authenticates with ${credential}, and only the root agent's servers take a credential: it is left out.`);
    else if (credential !== undefined) {
      const slot = secrets[credential];
      const taken = (name: string) => Object.keys(headers).some((header) => header.toLowerCase() === name.toLowerCase());
      const wanted = headerOfSlot(slot);
      if (isObject(slot) && slot.type === "headers") {
        const header = [wanted, "X-Api-Key", "X-Credential"].find((name) => name !== undefined && !taken(name)) ?? `X-${credential}`;
        headers[header] = `\${${credential}}`;
        useCredential(writer, credential, { type: "headers", url, header });
      } else if (!taken("Authorization")) {
        headers.Authorization = `Bearer \${${credential}}`;
        useCredential(writer, credential, { type: "bearer", url });
      } else {
        const header = ["X-Credential", "X-Api-Key"].find((name) => !taken(name)) ?? `X-${credential}`;
        headers[header] = `\${${credential}}`;
        useCredential(writer, credential, { type: "headers", url, header });
      }
    }
    servers[key] = {
      type: server.type,
      url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
    const settings: Record<string, unknown> = {};
    if (server.deferred !== undefined) settings.deferred = server.deferred;
    if (server.tools !== undefined) settings.tools = server.tools;
    if (Object.keys(settings).length > 0) serverSettings[key] = settings;
    if (isObject(server.plugin))
      note(`MCP server ${key} came from plugin ${String(server.plugin.name)}; the manifest does not hold the plugin, so it is written as the folder's own server.`);
    if (isObject(server.headers) && Object.keys(server.headers).length === 0) note(`MCP server ${key}: its empty headers map is left out.`);
  }
  if (Object.keys(servers).length > 0) files.set(`${at}mcp.json`, json({ mcpServers: servers }));
  if (Object.keys(serverSettings).length > 0) front.mcpServers = serverSettings;

  // --- Skills ------------------------------------------------------------------------------
  const skillSettings: Record<string, Record<string, unknown>> = {};
  for (const [key, skill] of Object.entries(harness.skills ?? {})) {
    if (isObject(skill.plugin))
      note(`Skill ${key} came from plugin ${String(skill.plugin.name)}; the manifest does not hold the plugin, so it is written as the folder's own skill.`);
    if (Array.isArray(skill.secrets)) {
      const listed = skill.secrets as string[];
      if (!root) note(`Skill ${key}: only the root agent's skills get secrets, so its secrets (${listed.join(", ")}) are left out.`);
      else {
        skillSettings[key] = { secrets: [...listed] };
        const sorted = [...new Set(listed)].sort();
        if (!same(sorted, listed)) note(`Skill ${key}: its secrets are sorted, each once${sorted.length === 0 ? ", and an empty list is left out" : ""}.`);
      }
    }
    const missing: string[] = [];
    for (const [path, hash] of Object.entries((skill.files as Record<string, string> | undefined) ?? {})) {
      const bytes = writer.bytesOf(hash);
      if (!bytes) {
        missing.push(`${path} (${hash})`);
        continue;
      }
      const file = `${at}skills/${key}/${path}`;
      if (path !== "SKILL.md") {
        files.set(file, bytes);
        continue;
      }
      const moved = withoutSkillSecrets(bytes);
      if (moved === undefined) files.set(file, bytes);
      else {
        files.set(file, moved);
        note(
          root
            ? `skills/${key}/SKILL.md: secrets moved to AGENT.md's skills block (D80), so the file and its hash change.`
            : `skills/${key}/SKILL.md: its secrets are left out, as only the root agent's skills get secrets, so the file and its hash change.`,
        );
      }
    }
    if (missing.length > 0) {
      if (!files.has(`${at}skills/${key}/SKILL.md`))
        files.set(
          `${at}skills/${key}/SKILL.md`,
          `---\n${frontmatter({ name: skill.name, description: skill.description })}---\nA placeholder: the saved manifest names this skill's files by hash only. Copy the skill's folder over this one.\n`,
        );
      note(`Skill ${key}: the manifest has its files by hash only, so copy the skill's folder into ${at}skills/${key}/. Missing: ${missing.join(", ")}.`);
    }
  }
  if (Object.keys(skillSettings).length > 0) front.skills = skillSettings;
  if (harness.skills !== undefined && Object.keys(harness.skills).length === 0) note("harness.skills is an empty map: it is left out.");

  if (harness.memory !== undefined) front.memory = harness.memory;
  if (harness.loop !== undefined) {
    if (isObject(harness.loop)) front.loop = harness.loop;
    else note("harness.loop is not a map, which AGENT.md needs: it is left out.");
  }
  if (identity.metadata !== undefined) {
    if (isObject(identity.metadata)) front.metadata = identity.metadata;
    else note("metadata is not a map, which AGENT.md needs: it is left out.");
  }
  if (harness.plugins !== undefined && harness.plugins.length > 0)
    note(`harness.plugins (${harness.plugins.map((plugin) => plugin.name).join(", ")}) is left out: the manifest names the plugins only, so their skills and servers are written as the folder's own.`);

  // --- Tools and subagents -----------------------------------------------------------------
  const tools = harness.tools ?? [];
  const listed: string[] = [];
  const http: string[] = [];
  const agents: string[] = [];
  for (const tool of tools) {
    const name = String(tool.name);
    if (tool.agent !== undefined) {
      if (place.role === "subagent") {
        note(`Tool ${name} is a subagent of a subagent, and agents used as tools nest one level deep: it is left out.`);
        continue;
      }
      writeSubagent(writer, place, tool);
      listed.push(name);
      agents.push(name);
      continue;
    }
    if (!isObject(tool.http)) {
      note(`Tool ${name} is neither an HTTP tool nor a subagent, which a folder cannot write: it is left out.`);
      continue;
    }
    const file: Record<string, unknown> = {};
    if (tool.description !== undefined) file.description = tool.description;
    file.inputSchema = tool.inputSchema;
    if (tool.outputSchema !== undefined) file.outputSchema = tool.outputSchema;
    file.http = tool.http;
    if (tool.approval !== undefined)
      note(`Tool ${name} has approval "${String(tool.approval)}", which a folder does not take: a person approves a call through the Tenant's tool policy (a rule with "effect": "ask"). It is left out.`);
    files.set(`${at}tools/${name}.json`, json(file));
    listed.push(name);
    http.push(name);
    if (typeof tool.http.credential === "string") useCredential(writer, tool.http.credential, { type: "bearer", url: String(tool.http.url) });
  }
  // The compiler lists tools/ by file name, then agents/ by folder name.
  const order = [...[...http].sort((a, b) => compare(`tools/${a}.json`, `tools/${b}.json`)), ...[...agents].sort(compare)];
  if (!same(order, listed))
    note(
      agents.length === 0
        ? `harness.tools are listed in file name order (${order.join(", ")}), as tools/ gives them.`
        : `harness.tools are listed as a folder gives them (${order.join(", ")}): tools/ by file name, then agents/ by folder name.`,
    );
  if (harness.tools !== undefined && harness.tools.length === 0) note("harness.tools is an empty list: it is left out.");

  // --- Instructions ------------------------------------------------------------------------
  const instructions = harness.instructions ?? [];
  if (harness.instructions !== undefined && instructions.length === 0) note("harness.instructions is an empty list: it is left out.");
  let body = "";
  const width = Math.max(2, String(instructions.length - 1).length);
  instructions.forEach((text, index) => {
    const prose = trimBlankLines(text.replace(/^﻿/, ""));
    if (!keepsProse(text))
      note(
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
    files.set(`${at}instructions/${String(index).padStart(width, "0")}${slug ? `-${slug}` : ""}.md`, `${prose}\n`);
  });

  files.set(`${at}${AGENT_FILE}`, `---\n${frontmatter(front)}---\n${body === "" ? "" : `${body}\n`}`);
}

/**
 * A tool with `agent`: `agents/<name>/`, offered back as the tool the compiler builds from it
 * (named by its folder, with the agent's description and `{ task }` input).
 */
function writeSubagent(writer: Writer, place: Place, tool: Json): void {
  const name = String(tool.name);
  const agent = tool.agent as AgentManifest | WorkflowManifest;
  const note = (text: string) => noteAt(writer, place, text);
  if (tool.description !== agent.description)
    note(`Tool ${name} is a subagent, whose description in a folder is its agent's${tool.description === undefined ? "" : `: the tool's own is left out`}.`);
  if (!same(tool.inputSchema, DELEGATE_INPUT_SCHEMA)) note(`Tool ${name} is a subagent, which takes { task } in a folder: its inputSchema is left out.`);
  if (tool.outputSchema !== undefined) note(`Tool ${name} is a subagent, whose output is its agent's outputSchema in a folder: the tool's is left out.`);
  if (tool.approval !== undefined)
    note(`Tool ${name} has approval "${String(tool.approval)}", which a folder does not take: a person approves a call through the Tenant's tool policy (a rule with "effect": "ask"). It is left out.`);
  writeEmbedded(writer, { prefix: `${place.prefix}agents/${name}/`, role: "subagent" }, name, agent);
}

/**
 * An agent embedded in a manifest (a subagent's, or a stage of a flow): v7 as an agent folder,
 * v3 as a flow folder. `id` is its folder's name, which its `AGENT.md` name must be.
 */
function writeEmbedded(writer: Writer, place: Place, id: string, agent: AgentManifest | WorkflowManifest, namespace?: Namespace): void {
  const note = (text: string) => noteAt(writer, place, text);
  if (agent.id !== id) note(`The embedded agent's id is ${agent.id}, and in a folder it is its folder's name, ${id}.`);
  if (agent.name !== undefined)
    note(`The agent's display name "${agent.name}" is left out: in a folder an agent's name is its id (design §3.2).`);
  const identity: Identity = { name: id, description: agent.description, metadata: agent.metadata };
  // Its `id` is the agent's, not the harness's: `AGENT.md`'s name holds it.
  if (isWorkflow(agent)) {
    const { id: _, ...flow } = agent;
    if (flow.sandbox !== undefined) note("The flow's sandbox is left out: a folder's agents run in the root's runtime.json.");
    writeFlow(writer, place, identity, flow, namespace);
    return;
  }
  const { id: _, ...fields } = agent;
  if (fields.requires !== undefined) note("requires is left out: a folder's agents need what the root's runtime.json gives.");
  writeAgent(writer, place, identity, fields as unknown as AgentFields);
}

/**
 * A flow folder: `AGENT.md` with no body, `flow.json`, the tools its nodes name, and its agents
 * in the flow root's `agents/` (`namespace`, which a sub-flow shares with the flow root).
 */
function writeFlow(writer: Writer, place: Place, identity: Identity, harness: FlowFields, namespace?: Namespace): void {
  const at = place.prefix;
  const note = (text: string) => noteAt(writer, place, text);
  const front = identityFront(writer, place, identity);
  if (harness.id !== undefined) front.harness = harness.id;
  schemaFile(writer, place, front, "inputSchema", INPUT_SCHEMA_FILE, harness.inputSchema, "harness.inputSchema");
  schemaFile(writer, place, front, "outputSchema", OUTPUT_SCHEMA_FILE, harness.outputSchema, "harness.outputSchema");
  if (harness.loop !== undefined) {
    if (isObject(harness.loop)) front.loop = harness.loop;
    else note("harness.loop is not a map, which AGENT.md needs: it is left out.");
  }
  if (identity.metadata !== undefined) {
    if (isObject(identity.metadata)) front.metadata = identity.metadata;
    else note("metadata is not a map, which AGENT.md needs: it is left out.");
  }
  if (harness.plugins !== undefined && harness.plugins.length > 0)
    note(`harness.plugins (${harness.plugins.map((plugin) => plugin.name).join(", ")}) is left out: a flow takes no plugins.`);
  const names: Namespace = namespace ?? { dir: `${at}agents/`, members: new Map() };

  // Tool files beside this flow.json: a stage's by its name, an HTTP verifier's by a new one.
  const taken = new Set<string>();
  const collect = (node: WorkflowNode): void => {
    if ("tool" in node) taken.add(node.tool.name);
    for (const child of childrenOf(node)) collect(child);
  };
  collect(harness.root);
  const tools = new Map<string, string>();
  const writeTool = (name: string, file: Record<string, unknown>) => {
    const known = tools.get(name);
    if (known !== undefined) {
      if (known !== canonical(file)) note(`Two tool stages are named ${name}, and tools/${name}.json holds one: the first is written for both.`);
      return;
    }
    tools.set(name, canonical(file));
    writer.files.set(`${at}tools/${name}.json`, json(file));
    const http = file.http;
    if (isObject(http) && typeof http.credential === "string") useCredential(writer, http.credential, { type: "bearer", url: String(http.url) });
  };
  const verifierName = () => {
    let name = "verify";
    for (let index = 2; taken.has(name); index++) name = `verify_${index}`;
    taken.add(name);
    return name;
  };

  const used: string[] = [];
  const named = (id: string) => {
    if (!used.includes(id)) used.push(id);
  };
  const withId = (node: WorkflowNode, built: Record<string, unknown>) => (node.id === undefined ? built : { id: node.id, ...built });
  const tree = (node: WorkflowNode): Record<string, unknown> => {
    if ("agent" in node) {
      named(node.agent);
      return withId(node, { agent: node.agent });
    }
    if ("tool" in node) {
      const { name, ...stage } = node.tool;
      const file: Record<string, unknown> = {};
      if (stage.description !== undefined) file.description = stage.description;
      if (stage.inputSchema === undefined) note(`Tool stage ${name} has no inputSchema, which tools/${name}.json needs: it is written as { "type": "object" }.`);
      file.inputSchema = stage.inputSchema ?? { type: "object" };
      if (stage.outputSchema !== undefined) file.outputSchema = stage.outputSchema;
      if (stage.http === undefined) note(`Tool stage ${name} has no http, which a folder's tool needs: tools/${name}.json does not compile until it has one.`);
      else file.http = stage.http;
      writeTool(name, file);
      return withId(node, { tool: name });
    }
    if ("chain" in node) return withId(node, { chain: node.chain.map(tree) });
    if ("switch" in node) {
      const cases = Object.fromEntries(Object.entries(node.switch.cases).map(([key, item]) => [key, tree(item)]));
      return withId(node, { switch: { cases, ...(node.switch.default === undefined ? {} : { default: tree(node.switch.default) }) } });
    }
    if ("parallel" in node) return withId(node, { parallel: Object.fromEntries(Object.entries(node.parallel).map(([key, item]) => [key, tree(item)])) });
    if ("map" in node) return withId(node, { map: { each: tree(node.map.each) } });
    const { verify, max } = node.loop;
    const run = tree(node.loop.run);
    let verifier: Record<string, unknown>;
    if ("agent" in verify) {
      named(verify.agent);
      verifier = { agent: verify.agent, ...(verify.id === undefined ? {} : { id: verify.id }) };
    } else {
      const name = verifierName();
      writeTool(name, { description: "Judges each attempt of the loop.", inputSchema: { type: "object" }, http: verify.http });
      verifier = { tool: name };
    }
    return withId(node, { loop: { run, verify: verifier, max } });
  };
  writer.files.set(`${at}${FLOW_FILE}`, json(tree(harness.root)));
  writer.files.set(`${at}${AGENT_FILE}`, `---\n${frontmatter(front)}---\n`);

  for (const id of Object.keys(harness.agents))
    if (!used.includes(id)) note(`Agent ${id} is embedded, and no node names it: a folder holds only the agents its flows name, so it is left out.`);
  for (const id of used) {
    const agent = harness.agents[id];
    if (agent === undefined) {
      note(`A node names agent ${id}, which the flow does not embed: ${names.dir}${id}/ is not written.`);
      continue;
    }
    const known = names.members.get(id);
    if (known !== undefined) {
      if (known !== canonical(agent))
        note(`It embeds an agent ${id} that differs from the one in ${names.dir}${id}/, and a flow root's agents/ holds one agent of an id: the one there is used.`);
      continue;
    }
    names.members.set(id, canonical(agent));
    writeEmbedded(writer, { prefix: `${names.dir}${id}/`, role: "stage" }, id, agent, names);
  }
}

/** The nodes directly inside `node`, with a loop's verifier agent. */
function childrenOf(node: WorkflowNode): WorkflowNode[] {
  if ("chain" in node) return [...node.chain];
  if ("switch" in node) return [...Object.values(node.switch.cases), ...(node.switch.default ? [node.switch.default] : [])];
  if ("parallel" in node) return Object.values(node.parallel);
  if ("map" in node) return [node.map.each];
  if ("loop" in node) return [node.loop.run];
  return [];
}

/** `runtime.json`, `triggers/` and `files/`: the uploaded folder's, without what it derives. */
function writeRuntime(writer: Writer, manifest: AgentManifestV8): void {
  const { files, notes, secrets } = writer;
  const runtime = manifest.runtime;
  const rest: Record<string, unknown> | undefined = runtime === undefined ? undefined : { ...runtime };
  let moved = false;

  // --- Triggers ----------------------------------------------------------------------------
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
  for (const [credential, places] of writer.uses) {
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
  if (rest && isObject(rest.secrets) && Object.keys(rest.secrets).length === 0 && Object.keys(secrets).length > 0) delete rest.secrets;

  // --- files/ ------------------------------------------------------------------------------
  if (rest && Array.isArray(rest.files) && rest.files.length > 0) {
    const last = rest.files.at(-1) as Record<string, unknown>;
    const seeded = isObject(last.files) ? (last.files as Record<string, string>) : undefined;
    if (
      last.path === WORKSPACE &&
      Object.keys(last).length === 2 &&
      seeded &&
      Object.values(seeded).every((hash) => writer.bytesOf(hash) !== undefined)
    ) {
      for (const [path, hash] of Object.entries(seeded)) files.set(`files/${path}`, writer.bytesOf(hash)!);
      rest.files = rest.files.slice(0, -1);
      if ((rest.files as unknown[]).length === 0) delete rest.files;
      moved = true;
    }
  }

  // --- runtime.json ------------------------------------------------------------------------
  // The compiler makes kind `none` itself for a folder with derived slots, triggers or files/.
  if (rest && !(moved && same(rest, { kind: "none" }))) files.set("runtime.json", json(rest));
}

function isWorkflow<T>(value: T): value is Extract<T, { kind: "workflow" }> {
  return isObject(value) && value.kind === "workflow";
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
