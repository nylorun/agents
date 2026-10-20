/**
 * Three-file authoring (protocol 16): `composeManifest(dir)` reads `agent.manifest.json`
 * and the files it names, and makes the one agent manifest v8 document the Runtime saves, with
 * the bytes of every file it names by hash. `nylorun apply` runs it for each folder.
 *
 * - `agent.manifest.json` (`AgentManifestFileSchema`): the manifest's name, description and
 *   metadata, with `harness` and `runtime` inline or as paths to the two files below.
 * - `harness.manifest.json` (`HarnessManifestFileSchema`): the harness section, whose `skills`
 *   may be a folder of skill folders (each skill's `secrets` from its SKILL.md's frontmatter),
 *   `mcpServers` an `mcp.json` (the Agent Plugins format), and
 *   `plugins` Agent Plugin folders, folded in as `.plugin()` folds them; `credentials` names the
 *   `runtime.secrets` slot each MCP server or HTTP tool authenticates with; `requires` is checked
 *   against the runtime section here, since the API never sees it.
 * - `runtime.manifest.json` (`RuntimeManifestFileSchema`): the runtime section, often shared by
 *   many agents; a `files` entry `{ path, from }` is a folder beside the file, hashed into
 *   `{ path, files }`.
 *
 * Each path is relative to the file that names it. Node only: it reads the files.
 *
 * Deprecated (D80): agent folders (`AGENT.md`) replace the three files, and every composed
 * manifest carries a warning naming `nylorun migrate folder`. It is still read.
 */
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AGENT_MANIFEST_V8_SCHEMA_VERSION,
  AgentManifestFileSchema,
  AgentManifestV8Schema,
  HarnessManifestFileSchema,
  RuntimeManifestFileSchema,
  WorkflowHarnessSectionSchema,
  type AgentManifestV8,
  type HarnessManifestFile,
  type RuntimeSection,
} from "@nylorun/core/contracts";
import type { AgentHarnessSection, HarnessMcpServer, HarnessSkill } from "@nylorun/core";
import { sectionGaps, type PluginLabel, type SkillFileSource } from "@nylorun/core/define";
import { requirementGaps, type ComposedManifest } from "./agent-manifests.js";
import { loadMcpServers, loadPlugin, type PluginDiagnostic } from "./plugins/load.js";
import { hashFolder, loadSkillsFromDirectory, type LoadedSkill, type SkillDiagnostic } from "./skills/load.js";

/** The file `composeManifest` reads in a folder. */
export const AGENT_MANIFEST_FILE = "agent.manifest.json";

/** An authoring file that cannot be read or does not validate; `path` names it. */
export class ComposeError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

type Schema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
};

/** The JSON file at `path`, as `schema` parses it, or a `ComposeError` naming every issue. */
async function readFileAs<T>(path: string, schema: Schema<T>, where: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ComposeError(path, `Cannot read ${where}: ${(error as NodeJS.ErrnoException).code ?? error}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ComposeError(path, `${where} is not JSON: ${(error as Error).message}`);
  }
  return parsedAs(value, schema, path, where);
}

function parsedAs<T>(value: unknown, schema: Schema<T>, path: string, where: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(
    (issue) => `  ${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`,
  );
  throw new ComposeError(path, `${where} is not valid:\n${issues.join("\n")}`);
}

const isWorkflow = (value: unknown): boolean =>
  !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "workflow";

/** `$schema` dropped: it is for editors. */
function withoutSchema<T extends object>(value: T): Omit<T, "$schema"> {
  const { $schema: _, ...rest } = value as T & { $schema?: unknown };
  return rest;
}

/** Reads the runtime section, its `{ path, from }` files hashed into `{ path, files }`. */
async function runtimeSection(
  runtime: unknown,
  base: string,
  agentFile: string,
  files: Map<string, SkillFileSource>,
  warnings: string[],
): Promise<RuntimeSection> {
  const file = typeof runtime === "string" ? resolve(base, runtime) : agentFile;
  const parsed =
    typeof runtime === "string"
      ? await readFileAs(file, RuntimeManifestFileSchema, relativeTo(file))
      : parsedAs(runtime, RuntimeManifestFileSchema, file, `${relativeTo(file)} runtime`);
  const at = dirname(file);
  const entries: NonNullable<RuntimeSection["files"]> = [];
  for (const entry of parsed.files ?? []) {
    if (!("from" in entry)) {
      entries.push(entry);
      continue;
    }
    const folder = resolve(at, entry.from);
    if (!existsSync(folder) || !statSync(folder).isDirectory())
      throw new ComposeError(file, `runtime.files: ${entry.from} (for ${entry.path}) is not a folder beside ${relativeTo(file)}`);
    const diagnostics: SkillDiagnostic[] = [];
    const hashed = hashFolder(folder, diagnostics);
    warnings.push(...warningsOf(diagnostics));
    if (Object.keys(hashed.files).length === 0)
      throw new ComposeError(file, `runtime.files: ${entry.from} (for ${entry.path}) holds no files`);
    for (const [sha256, source] of Object.entries(hashed.sources)) files.set(sha256, source);
    entries.push({ path: entry.path, files: { ...hashed.files } });
  }
  const section = withoutSchema(parsed);
  return { ...section, ...(parsed.files === undefined ? {} : { files: entries }) } as RuntimeSection;
}

function warningsOf(diagnostics: readonly (SkillDiagnostic | PluginDiagnostic)[]): string[] {
  return diagnostics.filter((item) => item.severity === "warning").map((item) => item.message);
}

/** `path` relative to the working directory, as a person reads it. */
function relativeTo(path: string): string {
  return relative(process.cwd(), path) || path;
}

/** A skill read from its folder as the harness section declares it, with its SKILL.md's `secrets`. */
function harnessSkill(skill: LoadedSkill): HarnessSkill {
  return {
    name: skill.name,
    description: skill.description,
    files: { ...skill.files },
    ...(skill.secrets === undefined ? {} : { secrets: [...skill.secrets] }),
  };
}

/** The agent harness section a `harness.manifest.json` describes, its paths resolved. */
function agentHarness(
  file: HarnessManifestFile,
  base: string,
  where: string,
  files: Map<string, SkillFileSource>,
  warnings: string[],
): AgentHarnessSection {
  const skills: Record<string, HarnessSkill> = {};
  const servers: Record<string, HarnessMcpServer> = {};
  const plugins: PluginLabel[] = [];
  const addSkill = (skill: HarnessSkill, from: string) => {
    if (skills[skill.name]) throw new ComposeError(where, `Skill ${skill.name} of ${from} is declared twice`);
    skills[skill.name] = skill;
  };
  const addServer = (key: string, server: HarnessMcpServer, from: string) => {
    if (servers[key]) throw new ComposeError(where, `MCP server ${key} of ${from} is declared twice`);
    servers[key] = server;
  };
  // Skills: a folder of skill folders, each hashed as `.skills()` hashes it.
  if (typeof file.skills === "string") {
    const diagnostics: SkillDiagnostic[] = [];
    for (const skill of Object.values(loadSkillsFromDirectory(resolve(base, file.skills), diagnostics))) {
      addSkill(harnessSkill(skill), file.skills);
      for (const [sha256, source] of Object.entries(skill.sources)) files.set(sha256, source);
    }
    warnings.push(...warningsOf(diagnostics));
  } else for (const skill of Object.values(file.skills ?? {})) addSkill(skill, where);
  // MCP servers: an `mcp.json` in the Agent Plugins format.
  if (typeof file.mcpServers === "string") {
    const path = resolve(base, file.mcpServers);
    if (!existsSync(path)) throw new ComposeError(where, `mcpServers: ${file.mcpServers} does not exist`);
    const diagnostics: PluginDiagnostic[] = [];
    const loaded = loadMcpServers(path, diagnostics, { codePrefix: "harness" });
    const invalid = diagnostics.find((item) => item.code === "harness.mcp-invalid");
    if (invalid) throw new ComposeError(path, `mcpServers: ${invalid.message}`);
    warnings.push(...warningsOf(diagnostics));
    for (const [key, server] of Object.entries(loaded)) addServer(key, server as HarnessMcpServer, file.mcpServers);
  } else for (const [key, server] of Object.entries(file.mcpServers ?? {})) addServer(key, server, where);
  // Plugins: a folder is folded in as `.plugin()` folds it, each part labelled with the plugin.
  for (const entry of file.plugins ?? []) {
    if (typeof entry !== "string") {
      plugins.push(entry);
      continue;
    }
    const loaded = loadPlugin(resolve(base, entry));
    warnings.push(...warningsOf(loaded.diagnostics).map((message) => `Plugin '${loaded.name}': ${message}`));
    const label: PluginLabel = { name: loaded.name, ...(loaded.version === undefined ? {} : { version: loaded.version }) };
    for (const skill of Object.values(loaded.skills)) {
      addSkill({ ...harnessSkill(skill), plugin: label }, entry);
      for (const [sha256, source] of Object.entries(skill.sources)) files.set(sha256, source);
    }
    for (const [key, server] of Object.entries(loaded.mcpServers))
      addServer(key, { ...(server as HarnessMcpServer), plugin: label }, entry);
    plugins.push(label);
  }
  // Credentials: the slot each server or HTTP tool authenticates with.
  let tools = file.tools;
  for (const [name, slot] of Object.entries(file.credentials ?? {})) {
    const server = servers[name];
    const tool = tools?.find((item) => item.name === name && item.http !== undefined);
    if (!server && !tool)
      throw new ComposeError(where, `credentials names ${name}, which is no MCP server or HTTP tool of the harness`);
    if (server) servers[name] = { ...server, credential: slot };
    if (tool) tools = tools!.map((item) => (item === tool ? { ...item, http: { ...item.http!, credential: slot } } : item));
  }
  return {
    ...(file.id === undefined ? {} : { id: file.id }),
    ...(file.instructions === undefined ? {} : { instructions: file.instructions }),
    ...(tools === undefined ? {} : { tools }),
    ...(Object.keys(skills).length === 0 ? {} : { skills }),
    ...(Object.keys(servers).length === 0 ? {} : { mcpServers: servers }),
    ...(plugins.length === 0 ? {} : { plugins }),
    ...(file.outputSchema === undefined ? {} : { outputSchema: file.outputSchema }),
    ...(file.loop === undefined ? {} : { loop: file.loop }),
    ...(file.memory === undefined ? {} : { memory: file.memory }),
  };
}

/**
 * The warning every three-file folder gets (D80): agent folders replace it. It is still read, and
 * removed in a later release.
 */
export function threeFileDeprecation(dir: string): string {
  const inside = relative(process.cwd(), dir);
  const where = inside === "" ? "." : inside.startsWith("..") || isAbsolute(inside) ? dir : inside;
  return `${AGENT_MANIFEST_FILE} (the three-file format) is deprecated: nylorun migrate folder ${where} writes it as an agent folder (AGENT.md), which saves the same manifest. It is still read until a later release.`;
}

/**
 * Composes the agent manifest in `dir` (its `agent.manifest.json`, or `options.file`): the v8
 * document to save, the bytes of every file it names by hash (skills, plugins' skills, runtime
 * files) for `client.agentManifests.save` to upload, its gaps (the harness file's `requires`
 * the runtime misses, and `sectionGaps`, which the Runtime would refuse it for), and the skills
 * and servers skipped. Throws `ComposeError` for a file that cannot be read or does not validate.
 */
export async function composeManifest(dir: string, options: { file?: string } = {}): Promise<ComposedManifest> {
  const agentFile = resolve(dir, options.file ?? AGENT_MANIFEST_FILE);
  const base = dirname(agentFile);
  const authored = await readFileAs(agentFile, AgentManifestFileSchema, relativeTo(agentFile));
  const files = new Map<string, SkillFileSource>();
  const warnings: string[] = [threeFileDeprecation(base)];
  const runtime =
    authored.runtime === undefined ? undefined : await runtimeSection(authored.runtime, base, agentFile, files, warnings);
  let harness: AgentManifestV8["harness"];
  let requires: HarnessManifestFile["requires"];
  const harnessFile = typeof authored.harness === "string" ? resolve(base, authored.harness) : agentFile;
  const where = relativeTo(harnessFile);
  const raw =
    typeof authored.harness === "string"
      ? await readFileAs(harnessFile, { safeParse: (value) => ({ success: true as const, data: value }) }, where)
      : authored.harness;
  if (isWorkflow(raw)) {
    // A flow: its agents are embedded, with their skills by hash; nothing to resolve.
    harness = parsedAs(withoutSchema(raw as object), WorkflowHarnessSectionSchema, harnessFile, where);
  } else {
    const file = parsedAs(raw, HarnessManifestFileSchema, harnessFile, where);
    requires = file.requires;
    harness = agentHarness(file, dirname(harnessFile), where, files, warnings);
  }
  const manifest = parsedAs(
    {
      manifestSchemaVersion: AGENT_MANIFEST_V8_SCHEMA_VERSION,
      name: authored.name,
      ...(authored.description === undefined ? {} : { description: authored.description }),
      ...(authored.metadata === undefined ? {} : { metadata: authored.metadata }),
      harness,
      ...(runtime === undefined ? {} : { runtime }),
    },
    AgentManifestV8Schema,
    agentFile,
    `The agent manifest ${authored.name}`,
  );
  const gaps = [...requirementGaps(requires, manifest.runtime).map((gap) => `harness.${gap}`), ...sectionGaps(manifest)];
  return { manifest, files, gaps, warnings };
}

/**
 * The folders `nylorun apply` composes for `dir`: `dir` itself when it holds an
 * `agent.manifest.json`, else each of its subfolders that does, by name.
 */
export async function manifestFolders(dir: string): Promise<string[]> {
  const root = resolve(dir);
  if (existsSync(join(root, AGENT_MANIFEST_FILE))) return [root];
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    throw new ComposeError(root, `Cannot read ${dir}: ${error.code ?? error}`);
  });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, AGENT_MANIFEST_FILE)))
    .map((entry) => join(root, entry.name))
    .sort();
}
