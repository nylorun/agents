import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stdioMcpRefusal, type McpServerManifest } from "@nylorun/core/define";
import {
  HEADER_NAME_PATTERN,
  LOOPBACK_HOSTS,
  McpServerManifestSchema,
} from "@nylorun/core/contracts";
import { loadSkillsFromDirectory, type LoadedSkill } from "../skills/load.js";

export const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const PLUGIN_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);

export interface PluginDiagnostic {
  readonly severity: "info" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class PluginError extends Error {
  readonly code: string;
  readonly diagnostics: readonly PluginDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: readonly PluginDiagnostic[] = []
  ) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface LoadedPlugin {
  readonly root: string;
  readonly name: string;
  readonly description?: string;
  readonly skills: Readonly<Record<string, LoadedSkill>>;
  readonly mcpServers: Readonly<Record<string, McpServerManifest>>;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export function loadPlugin(directory: string): LoadedPlugin {
  const root = resolveRoot(directory);
  const manifestPath = join(root, "plugin.json");
  const manifestReal = realInside(root, manifestPath);
  if (!manifestReal || !existsSync(manifestReal) || !statSync(manifestReal).isFile())
    throw new PluginError(
      "plugin.manifest-missing",
      `plugin.json must be a file inside ${root}`,
      [{ severity: "warning", code: "plugin.manifest-missing", message: "plugin.json is missing or escapes the package root", path: manifestPath }]
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestReal, "utf8"));
  } catch {
    throw new PluginError("plugin.manifest-invalid", "plugin.json is not valid JSON");
  }
  if (!isRecord(parsed))
    throw new PluginError("plugin.manifest-invalid", "plugin.json must be a JSON object");
  const diagnostics: PluginDiagnostic[] = [];
  for (const key of Object.keys(parsed)) {
    if (!PLUGIN_FIELDS.has(key))
      diagnostics.push({
        severity: "warning",
        code: "plugin.unknown-field",
        message: `Ignored unknown plugin.json field '${key}'`,
        path: manifestPath,
      });
  }
  if (parsed.$schema !== PLUGIN_SCHEMA)
    throw new PluginError(
      "plugin.schema-unsupported",
      "plugin.json $schema must be the Agent Plugins 1.0.0 plugin schema",
      diagnostics
    );
  if (!isPluginName(parsed.name))
    throw new PluginError(
      "plugin.name-invalid",
      "plugin.json name must be 1-64 characters of lowercase letters, digits, hyphens, and periods",
      diagnostics
    );
  validateMetadata(parsed, diagnostics);
  const extensions = parsed.extensions;
  if (extensions !== undefined && !isRecord(extensions))
    diagnostics.push({
      severity: "warning",
      code: "plugin.extensions-ignored",
      message: "Ignored non-object extensions field",
      path: manifestPath,
    });
  else if (isRecord(extensions)) {
    for (const namespace of Object.keys(extensions))
      diagnostics.push({
        severity: "info",
        code: "plugin.extension-ignored",
        message: `Ignored unimplemented extension namespace '${namespace}'`,
        path: manifestPath,
      });
  }
  const skills = loadSkills(root, diagnostics);
  const mcpServers = loadMcp(root, diagnostics);
  return {
    root,
    name: parsed.name,
    ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
    skills,
    mcpServers,
    diagnostics,
  };
}

function resolveRoot(directory: string): string {
  const resolved = resolve(directory);
  if (!existsSync(resolved))
    throw new PluginError("plugin.missing", `Plugin directory does not exist: ${directory}`);
  const real = realpathSync(resolved);
  if (!statSync(real).isDirectory())
    throw new PluginError("plugin.missing", `Plugin path is not a directory: ${directory}`);
  return real;
}

function validateMetadata(manifest: Record<string, unknown>, diagnostics: PluginDiagnostic[]): void {
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    if (manifest[field] !== undefined && typeof manifest[field] !== "string")
      throw new PluginError("plugin.manifest-invalid", `plugin.json ${field} must be a string`, diagnostics);
  }
  if (manifest.keywords !== undefined) {
    if (!Array.isArray(manifest.keywords) || manifest.keywords.some((item) => typeof item !== "string"))
      throw new PluginError("plugin.manifest-invalid", "plugin.json keywords must be an array of strings", diagnostics);
  }
  if (manifest.author !== undefined) {
    if (!isRecord(manifest.author))
      throw new PluginError("plugin.manifest-invalid", "plugin.json author must be an object", diagnostics);
    for (const key of Object.keys(manifest.author)) {
      if (!AUTHOR_FIELDS.has(key) || typeof manifest.author[key] !== "string")
        throw new PluginError("plugin.manifest-invalid", "plugin.json author contains an invalid field", diagnostics);
    }
  }
}

function loadSkills(
  root: string,
  diagnostics: PluginDiagnostic[]
): Readonly<Record<string, LoadedSkill>> {
  const location = join(root, "skills");
  if (!existsSync(location)) return {};
  const real = realInside(root, location);
  if (!real || !statSync(real).isDirectory()) {
    diagnostics.push({
      severity: "warning",
      code: "plugin.skills-invalid",
      message: "skills/ is not a directory inside the package",
      path: location,
    });
    return {};
  }
  return loadSkillsFromDirectory(real, diagnostics as never, {
    boundary: root,
    codePrefix: "plugin",
  });
}

function loadMcp(
  root: string,
  diagnostics: PluginDiagnostic[]
): Readonly<Record<string, McpServerManifest>> {
  const location = join(root, "mcp.json");
  if (!existsSync(location)) return {};
  const real = realInside(root, location);
  if (!real || !statSync(real).isFile()) {
    diagnostics.push({
      severity: "warning",
      code: "plugin.mcp-invalid",
      message: "mcp.json is not a file inside the package",
      path: location,
    });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    diagnostics.push({
      severity: "warning",
      code: "plugin.mcp-invalid",
      message: "mcp.json is not valid JSON",
      path: location,
    });
    return {};
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "$schema" && key !== "mcpServers")) {
    diagnostics.push({
      severity: "warning",
      code: "plugin.mcp-invalid",
      message: "mcp.json must contain only $schema and mcpServers",
      path: location,
    });
    return {};
  }
  if (parsed.$schema !== MCP_SCHEMA) {
    diagnostics.push({
      severity: "warning",
      code: "plugin.mcp-invalid",
      message: "mcp.json $schema does not match the plugin schema version",
      path: location,
    });
    return {};
  }
  if (!isRecord(parsed.mcpServers)) {
    diagnostics.push({
      severity: "warning",
      code: "plugin.mcp-invalid",
      message: "mcp.json mcpServers must be an object",
      path: location,
    });
    return {};
  }
  const servers: Record<string, McpServerManifest> = {};
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (isRecord(value) && value.type === "stdio")
      throw new PluginError("plugin.mcp-stdio", stdioMcpRefusal(name), diagnostics);
    const server = validateServer(name, value);
    if (typeof server === "string") {
      diagnostics.push({
        severity: "warning",
        code: "plugin.mcp-server-skipped",
        message: `Skipped invalid MCP server '${name}': ${server}`,
        path: location,
      });
      continue;
    }
    servers[name] = server;
  }
  return servers;
}

/** The server, or why it is skipped. */
function validateServer(name: string, value: unknown): McpServerManifest | string {
  if (!isRecord(value) || typeof value.type !== "string") return "it has no type";
  if (value.type === "streamable-http" || value.type === "sse")
    return validateRemote(name, value);
  return `type '${value.type}' is not streamable-http or sse`;
}

/**
 * A plugin's server as a manifest declares it (`McpServerManifestSchema`), named by its key. A
 * plugin may set only type, url and headers, and the URL and headers must be fit to send.
 */
function validateRemote(
  name: string,
  value: Record<string, unknown>
): McpServerManifest | string {
  const allowed = new Set(["type", "url", "headers"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `${value.type} servers take only type, url and headers, not ${unknown.join(", ")}`;
  const parsed = McpServerManifestSchema.safeParse({ ...value, name });
  if (!parsed.success)
    return parsed.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
  const server = parsed.data;
  const problem = remoteUrlProblem(server.url);
  if (problem) return problem;
  const seen = new Set<string>();
  for (const [key, item] of Object.entries(server.headers ?? {})) {
    if (!HEADER_NAME_PATTERN.test(key) || /[\r\n\0]/.test(item))
      return `header '${key}' is not a valid header`;
    const folded = key.toLowerCase();
    if (seen.has(folded)) return `header '${key}' is repeated`;
    seen.add(folded);
  }
  return server;
}

/**
 * Why `value` is not a remote server URL: https, or plain http to this machine's loopback (a
 * local Tenant in Docker reaches it on the Docker host). No credentials or fragment.
 */
function remoteUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `url '${value}' is not a URL`;
  }
  if (url.username || url.password) return "url must not carry credentials; use headers";
  if (url.hash) return "url must not have a fragment";
  if (url.protocol === "https:") return undefined;
  if (url.protocol !== "http:") return `url must be https, not ${url.protocol.slice(0, -1)}`;
  if (LOOPBACK_HOSTS.test(url.hostname)) return undefined;
  return `plain http is allowed only for localhost, 127.0.0.1 or [::1]; use https for ${url.hostname}`;
}

function isPluginName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && value.length !== 1)
    return false;
  if (value.length === 1) return /^[a-z0-9]$/.test(value);
  return !value.includes("--") && !value.includes("..");
}

function realInside(root: string, candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined;
  try {
    const real = realpathSync(candidate);
    return isInside(root, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
