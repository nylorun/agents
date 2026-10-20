/**
 * Agent manifest v8's two sections against each other (protocol 16). The Runtime sees
 * both sections when a manifest is saved, so it checks there what `requires` used to check when a
 * session opened: every gap is named in one `422 manifest_inconsistent`, and a dry run reports
 * them as plan errors. The CLI and the SDK run the same checks while they compose the files.
 */
import type { AgentManifestV8, RuntimeSection } from "../contracts.js";
import type {
  AgentHarnessSection,
  AgentManifest,
  HarnessSection,
  McpServerManifest,
  SkillManifest,
  WorkflowHarnessSection,
} from "../types/manifest.js";
import type { WorkflowManifest } from "../types/workflow.js";
import { DEFAULT_HARNESS } from "../utils/harness-id.js";
import { forEachFlowNode } from "./flow/paths.js";

/** What the loop needs of the runtime: a pod, any sandbox (`virtual` or `pod`), or nothing. */
export type SandboxNeed = "pod" | "sandbox" | "none";

export function isWorkflowHarness(harness: HarnessSection): harness is WorkflowHarnessSection {
  return (harness as { kind?: unknown }).kind === "workflow";
}

/** The harness that runs the loop: `harness.id`, else ours. */
export function harnessIdOf(harness: HarnessSection): string {
  return harness.id ?? DEFAULT_HARNESS;
}

/** Whether a loop manifest, or any agent it embeds or delegates to, carries skills. */
function hasSkills(manifest: AgentManifest | WorkflowManifest): boolean {
  if ("kind" in manifest) return Object.values(manifest.agents).some(hasSkills);
  if (Object.keys(manifest.skills ?? {}).length > 0) return true;
  return (manifest.tools ?? []).some((tool) => tool.agent !== undefined && hasSkills(tool.agent));
}

/**
 * What the harness section needs of the runtime, derived rather than declared: a custom harness
 * needs a pod (it runs from the pod's image); skills need a sandbox to be mounted in; otherwise
 * nothing.
 */
export function sandboxNeedOf(harness: HarnessSection): SandboxNeed {
  if (harnessIdOf(harness) !== DEFAULT_HARNESS) return "pod";
  if (isWorkflowHarness(harness)) return Object.values(harness.agents).some(hasSkills) ? "sandbox" : "none";
  if (Object.keys(harness.skills ?? {}).length > 0) return "sandbox";
  return (harness.tools ?? []).some((tool) => tool.agent !== undefined && hasSkills(tool.agent)) ? "sandbox" : "none";
}

/** Whether a runtime of `kind` gives the loop what it needs. */
export function kindMeets(kind: RuntimeSection["kind"], need: SandboxNeed): boolean {
  if (need === "pod") return kind === "pod";
  if (need === "sandbox") return kind === "virtual" || kind === "pod";
  return true;
}

/**
 * A credential URL as the vault compares it: origin, path and query, with the default port and
 * no fragment. Undefined for a URL the vault would refuse. The vault binds a `bearer` or
 * `headers` credential to one URL and sends it to a server or HTTP tool declared at exactly that
 * URL, so a slot covers a server when the two normalize the same.
 */
export function normalizeCredentialUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))
    url.port = "";
  return `${url.origin}${url.pathname}${url.search}`;
}

const quoted = (value: string): string => JSON.stringify(value);

/** The runtime section an Agent made from `manifest` has: `kind: "none"` when it is absent. */
export function runtimeOf(manifest: Pick<AgentManifestV8, "runtime">): RuntimeSection {
  return manifest.runtime ?? { kind: "none" };
}

/**
 * Every gap between the harness and runtime sections, worded for a person, in the manifest's
 * order. Empty when they fit:
 *
 * 1. A custom harness (`harness.id` not `nylorun`) needs `runtime.kind` `pod` with an `image`.
 * 2. Every credential the harness names is a declared slot of the right type: an MCP server's,
 *    HTTP tool's, flow HTTP stage's or HTTP verifier's `credential` (an embedded agent's too) a
 *    `bearer` or `headers` slot bound to its URL, a skill's `secrets` `environment_secret` or
 *    `environment_variable` slots.
 * 3. The runtime's kind gives the harness the sandbox it needs (`sandboxNeedOf`).
 */
export function sectionGaps(manifest: Pick<AgentManifestV8, "harness" | "runtime">): string[] {
  return sectionGapsAt(manifest).map((gap) => gap.message);
}

/** One gap of `sectionGapsAt`: the manifest field it is about, and why. */
export interface SectionGap {
  /** The field in the manifest, such as `["harness", "tools", 0, "http", "credential"]`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * `sectionGaps`, each with the manifest field it is about, so a caller that knows where each
 * field came from (the agent folder compiler) can point at the file that wrote it.
 */
export function sectionGapsAt(manifest: Pick<AgentManifestV8, "harness" | "runtime">): SectionGap[] {
  const { harness } = manifest;
  const runtime = runtimeOf(manifest);
  const gaps: SectionGap[] = [];
  const gap = (path: readonly (string | number)[], message: string) => gaps.push({ path, message });
  const kindText = manifest.runtime === undefined ? "the manifest has no runtime section" : `the runtime is ${quoted(runtime.kind)}`;
  // 1. A custom harness runs from its pod's image.
  const harnessId = harnessIdOf(harness);
  if (harnessId !== DEFAULT_HARNESS) {
    if (runtime.kind !== "pod") gap(["harness", "id"], `harness.id ${quoted(harnessId)} needs runtime.kind "pod"; ${kindText}`);
    else if (runtime.image === undefined)
      gap(["harness", "id"], `harness.id ${quoted(harnessId)} needs runtime.image: a custom harness runs from its pod's image`);
  }
  // 2. Credentials name declared slots of the right type.
  const slots = runtime.secrets ?? {};
  const urlSlot = (where: string, path: readonly (string | number)[], name: string, url: string, what: string): void => {
    const slot = slots[name];
    if (slot === undefined) {
      gap(path, `${where} ${quoted(name)} is not a secret slot in runtime.secrets`);
      return;
    }
    if (slot.type !== "bearer" && slot.type !== "headers") {
      gap(path, `${where} ${quoted(name)} is a slot of type ${slot.type}; ${what} needs a bearer or headers slot`);
      return;
    }
    const want = normalizeCredentialUrl(url);
    if (want === undefined || normalizeCredentialUrl(slot.url) !== want)
      gap(path, `${where} ${quoted(name)} is bound to ${slot.url}, not to ${what}'s URL ${url}`);
  };
  // The Tool Gate sends an HTTP target's `credential` from the vault by that name, wherever the
  // target sits: an agent's HTTP tool, a flow's HTTP stage or HTTP verifier, or one of an
  // embedded agent's.
  const agentTools = (tools: AgentManifest["tools"], at: string, path: readonly (string | number)[]): void => {
    for (const [index, tool] of (tools ?? []).entries()) {
      if (tool.http?.credential !== undefined)
        urlSlot(`${at}.tools.${tool.name}.http.credential`, [...path, "tools", index, "http", "credential"], tool.http.credential, tool.http.url, "an HTTP tool");
      if (tool.agent !== undefined) embedded(tool.agent, `${at}.tools.${tool.name}.agent`, [...path, "tools", index, "agent"]);
    }
  };
  const flowStages = (flow: Pick<WorkflowManifest, "root" | "agents">, at: string, path: readonly (string | number)[]): void => {
    forEachFlowNode(flow.root, ({ node, key, role }) => {
      const http = "http" in node ? node.http : "tool" in node ? node.tool.http : undefined;
      if (http?.credential !== undefined)
        urlSlot(
          `${at}.root stage ${quoted(key)} http.credential`,
          [...path, "root"],
          http.credential,
          http.url,
          role === "verify" ? "an HTTP verifier" : "an HTTP stage",
        );
    });
    for (const [id, agent] of Object.entries(flow.agents)) embedded(agent, `${at}.agents.${id}`, [...path, "agents", id]);
  };
  const embedded = (agent: AgentManifest | WorkflowManifest, at: string, path: readonly (string | number)[]): void =>
    "kind" in agent ? flowStages(agent, at, path) : agentTools(agent.tools, at, path);
  if (isWorkflowHarness(harness)) flowStages(harness, "harness", ["harness"]);
  else {
    for (const [key, server] of Object.entries(harness.mcpServers ?? {}))
      if (server.credential !== undefined)
        urlSlot(`harness.mcpServers.${key}.credential`, ["harness", "mcpServers", key, "credential"], server.credential, server.url, "an MCP server");
    agentTools(harness.tools, "harness", ["harness"]);
    for (const [key, skill] of Object.entries(harness.skills ?? {}))
      for (const name of skill.secrets ?? []) {
        const slot = slots[name];
        const path = ["harness", "skills", key, "secrets"];
        if (slot === undefined) gap(path, `harness.skills.${key}.secrets ${quoted(name)} is not a secret slot in runtime.secrets`);
        else if (slot.type !== "environment_secret" && slot.type !== "environment_variable")
          gap(
            path,
            `harness.skills.${key}.secrets ${quoted(name)} is a slot of type ${slot.type}; a skill reads environment_secret or environment_variable slots`,
          );
      }
  }
  // 3. The sandbox the loop needs. A custom harness's pod is gap 1.
  const need = sandboxNeedOf(harness);
  if (need === "sandbox" && !kindMeets(runtime.kind, need)) {
    const what = isWorkflowHarness(harness) ? "harness.agents carry skills, which need" : "harness.skills needs";
    gap(
      ["harness", isWorkflowHarness(harness) ? "agents" : "skills"],
      manifest.runtime === undefined
        ? `${what} a sandbox; the manifest has no runtime section, so an Agent made from it has none`
        : `${what} a sandbox; runtime.kind ${quoted(runtime.kind)} has none`,
    );
  }
  return gaps;
}

/**
 * The loop manifest the harness runs for a version of an agent manifest: the harness section
 * with the manifest's name as its id, in the shape the engine reads (agent manifest v7, workflow
 * manifest v3). The fields only the Runtime reads (`credential`, a skill's `secrets`, `plugins`,
 * `loop`, the harness id) stay out.
 */
export function loopManifestOf(
  manifest: Pick<AgentManifestV8, "name" | "description" | "metadata" | "harness">,
): AgentManifest | WorkflowManifest {
  const { harness } = manifest;
  const identity = {
    id: manifest.name,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.metadata === undefined ? {} : { metadata: manifest.metadata }),
  };
  if (isWorkflowHarness(harness))
    return {
      kind: "workflow",
      workflowSchemaVersion: 3,
      ...identity,
      ...(harness.inputSchema === undefined ? {} : { inputSchema: harness.inputSchema }),
      ...(harness.outputSchema === undefined ? {} : { outputSchema: harness.outputSchema }),
      root: harness.root,
      agents: harness.agents,
    };
  const skills = Object.entries(harness.skills ?? {}).map(([key, { secrets: _, ...skill }]): [string, SkillManifest] => [key, skill]);
  const servers = Object.entries(harness.mcpServers ?? {}).map(
    ([key, { credential: _, ...server }]): [string, McpServerManifest] => [key, server as McpServerManifest],
  );
  return {
    manifestSchemaVersion: 7,
    ...identity,
    ...(harness.outputSchema === undefined ? {} : { outputSchema: harness.outputSchema }),
    ...(harness.instructions === undefined ? {} : { instructions: harness.instructions }),
    ...(harness.tools === undefined ? {} : { tools: harness.tools }),
    ...(skills.length === 0 ? {} : { skills: Object.fromEntries(skills) }),
    ...(servers.length === 0 ? {} : { mcpServers: Object.fromEntries(servers) }),
  };
}

/**
 * The harness section a loop manifest makes (an SDK-built agent or flow, or a v7 manifest being
 * migrated): its loop fields, without its identity, which the agent manifest holds. A v7
 * manifest's `requires.secrets` become no skill's: the composer asks for them by name.
 */
export function harnessSectionOf(
  loop: AgentManifest | WorkflowManifest,
  options: { harness?: string; plugins?: AgentHarnessSection["plugins"] } = {},
): HarnessSection {
  const plugins = options.plugins ?? pluginsOf(loop);
  const extra = {
    ...(options.harness === undefined || options.harness === DEFAULT_HARNESS ? {} : { id: options.harness }),
    ...(plugins.length === 0 ? {} : { plugins }),
  };
  if ("kind" in loop)
    return {
      kind: "workflow",
      ...extra,
      ...(loop.inputSchema === undefined ? {} : { inputSchema: loop.inputSchema }),
      ...(loop.outputSchema === undefined ? {} : { outputSchema: loop.outputSchema }),
      root: loop.root,
      agents: loop.agents,
    };
  return {
    ...extra,
    ...(loop.instructions === undefined ? {} : { instructions: loop.instructions }),
    ...(loop.tools === undefined ? {} : { tools: loop.tools }),
    ...(loop.skills === undefined ? {} : { skills: loop.skills }),
    ...(loop.mcpServers === undefined ? {} : { mcpServers: loop.mcpServers }),
    ...(loop.outputSchema === undefined ? {} : { outputSchema: loop.outputSchema }),
  };
}

/** The Agent Plugins whose labels a loop manifest's skills and servers carry, each once, by name. */
export function pluginsOf(loop: AgentManifest | WorkflowManifest): { name: string; version?: string }[] {
  if ("kind" in loop) return [];
  const byName = new Map<string, { name: string; version?: string }>();
  for (const item of [...Object.values(loop.skills ?? {}), ...Object.values(loop.mcpServers ?? {})])
    if (item.plugin !== undefined && !byName.has(item.plugin.name))
      byName.set(item.plugin.name, { ...item.plugin });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
