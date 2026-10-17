/**
 * Agent manifests (protocol 16, track T2): `client.agentManifests`. An agent manifest (v8) is one
 * named, versioned document with what runs inside the agent loop (`harness`: the harness's id,
 * instructions, tools, skills, MCP servers, plugins, output schema, the harness's own `loop`
 * settings, memory; or a flow, `kind: "workflow"`) and what the Runtime provides around it
 * (`runtime`: kind, image, network, setup, files, limits, secret slots). The Runtime checks the
 * two against each other when it is saved (`422 manifest_inconsistent`); an Agent
 * (`client.agents`) is made from one version.
 *
 * `save` takes the document, what `composeManifest` read from a folder, or a built agent or flow
 * with the runtime section to run it in: the SDK makes the harness section from the agent's
 * manifest (`harnessSectionOf`), with its skills' `secrets`, `loop` and `memory`. It first
 * uploads the files the manifest names by hash that the Runtime does not hold (skills, a flow's
 * agents' skills, runtime files), and refuses before sending a tool that runs your code or an
 * `approval`, as the Runtime runs agents from their manifests alone.
 */
import {
  AGENT_MANIFEST_V8_SCHEMA_VERSION,
  AgentManifestV8Schema,
  isAgentManifestName,
  type AgentHarnessSection,
  type AgentManifestPlan,
  type AgentManifestV8,
  type AgentMemorySettings,
  type AgentManifestVersions,
  type AgentManifestView,
  type DeleteAgentManifestResponse,
  type RuntimeSection,
  type SaveAgentManifestResponse,
} from "@nylorun/core/contracts";
import {
  approvalRefusal,
  codeToolRefusal,
  delegateOf,
  harnessSectionOf,
  isBuiltWorkflow,
  loopManifestOf,
  type AgentManifest,
  type BuiltAgent,
  type BuiltWorkflow,
  type JsonObject,
  type SkillFileSource,
  type WorkflowManifest,
} from "@nylorun/core/define";
import { FilesClient } from "./files.js";
import { id, segment, type Transport } from "./http.js";

/** A built agent or flow, or anything with its id and manifest. */
export interface AgentSource {
  readonly id: string;
  readonly manifest: AgentManifest | WorkflowManifest;
  build?(): BuiltAgent | BuiltWorkflow;
  getBinding?: BuiltAgent["getBinding"] | BuiltWorkflow["getBinding"];
}

/** An agent manifest v8 as authored: `manifestSchemaVersion` may be left out, and `$schema` is dropped. */
export type AgentManifestDocument = Omit<AgentManifestV8, "manifestSchemaVersion"> & {
  readonly manifestSchemaVersion?: typeof AGENT_MANIFEST_V8_SCHEMA_VERSION;
  readonly $schema?: string;
};

/** An agent manifest made from a built agent or flow (as `saveAgent` took it before protocol 16). */
export interface AgentManifestFromAgent {
  readonly agent: AgentSource | BuiltWorkflow;
  /** The manifest's name. Default: the agent's id. */
  readonly name?: string;
  /** Default: the agent's description. */
  readonly description?: string;
  /** Default: the agent's metadata. */
  readonly metadata?: JsonObject;
  /** The harness that runs the loop (`harness.id`). Default ours, `nylorun`. */
  readonly harness?: string;
  /** What the Runtime provides around the loop. Without it, an Agent made from it is kind `none`. */
  readonly runtime?: RuntimeSection;
  /** The harness's own settings (`harness.loop`), passed to it in `turn.start`. */
  readonly loop?: JsonObject;
  /**
   * Turns on the Agent's memory (`harness.memory`): `access` `read_write` (the default) or
   * `read_only`, and `instructions` on what to remember. An agent's only, not a flow's.
   */
  readonly memory?: AgentMemorySettings;
}

/** What `composeManifest` read from a folder: the document, the bytes of the files it names, its gaps. */
export interface ComposedManifest {
  readonly manifest: AgentManifestV8;
  /** Each file the manifest names by hash (its skills', its runtime's), by `sha256:<hex>`. */
  readonly files: ReadonlyMap<string, SkillFileSource>;
  /**
   * Why the Runtime would refuse it (`sectionGaps`), and where it misses what the harness file's
   * `requires` asks of its runtime, which only the composer checks.
   */
  readonly gaps: readonly string[];
  /** Skills and servers the folders hold that were skipped, and why. */
  readonly warnings: readonly string[];
}

export type AgentManifestInput = AgentManifestDocument | AgentManifestFromAgent | ComposedManifest;

/** File bytes to upload before a save, by `sha256:<hex>` (`runtimeFiles(...).bytes`, or sources). */
export type DefinitionFiles = ReadonlyMap<string, SkillFileSource> | Readonly<Record<string, Uint8Array>>;

export interface AgentManifestSaveOptions {
  /** The version you read (`0` for none yet): a save over a newer one is `412 manifest_changed`. */
  ifMatch?: number;
  requestId?: string;
  /** More files to upload when the Runtime lacks them (a document's runtime files by hash). */
  files?: DefinitionFiles;
  signal?: AbortSignal;
}

/** A manifest the SDK refuses before sending: its sections do not fit, or it misses its `requires`. */
export class ManifestGapsError extends Error {
  constructor(
    /** The manifest's name. */
    readonly manifest: string,
    readonly gaps: readonly string[],
  ) {
    super(`Agent manifest ${manifest} does not fit its runtime:\n${gaps.map((gap) => `  - ${gap}`).join("\n")}`);
    this.name = "ManifestGapsError";
  }
}

/** An agent's binding, with its parts; none for a flow. */
function agentBindingOf(agent: AgentSource) {
  if (isBuiltWorkflow(agent) || (agent.manifest as { kind?: string }).kind === "workflow") return undefined;
  const built = agent.build?.() ?? agent;
  if (isBuiltWorkflow(built)) return undefined;
  const binding = built.getBinding?.();
  return binding && "parts" in binding ? binding : undefined;
}

/** The agent's declarations, then those of each agent it uses as a tool. */
function declarationsOf(agent: AgentSource) {
  const binding = agentBindingOf(agent);
  if (!binding) return [];
  const found = [...(binding.parts ?? [])];
  for (const tool of binding.tools ?? []) {
    const delegate = delegateOf(tool);
    found.push(...(delegate?.agent?.getBinding().parts ?? []));
    // A flow agent used as a tool: its agents' declarations.
    for (const leaf of Object.values(delegate?.workflow?.getBinding().agents ?? {})) found.push(...(leaf.parts ?? []));
  }
  return found;
}

/** The bytes of every skill file the agent's definition names, by `sha256:<hex>`. */
function skillFilesOf(agent: AgentSource | BuiltWorkflow, into = new Map<string, SkillFileSource>()) {
  if (isBuiltWorkflow(agent)) {
    // A flow agent embeds its agents: one document, carrying their files.
    for (const binding of Object.values(agent.getBinding().agents))
      skillFilesOf({ id: binding.manifest.id, manifest: binding.manifest, getBinding: () => binding }, into);
    return into;
  }
  for (const item of declarationsOf(agent))
    for (const [sha256, source] of Object.entries(item.skillFiles ?? {})) into.set(sha256, source);
  return into;
}

/**
 * The harness section's skills with the secret slots each reads (a SKILL.md's `secrets`, which
 * `.skills()` and `.plugin()` keep on the agent's parts, outside its v7 manifest).
 */
function withSkillSecrets(agent: AgentSource, skills: AgentHarnessSection["skills"]): AgentHarnessSection["skills"] {
  const secrets: Record<string, readonly string[]> = Object.assign(
    {},
    ...(agentBindingOf(agent)?.parts ?? []).map((part) => part.skillSecrets ?? {}),
  );
  if (skills === undefined || Object.keys(secrets).length === 0) return skills;
  return Object.fromEntries(
    Object.entries(skills).map(([key, skill]) => [key, secrets[key] ? { ...skill, secrets: [...secrets[key]] } : skill]),
  );
}

const quoted = (value: string) => JSON.stringify(value);

/**
 * Where a runtime section misses what a harness `requires` (agent manifest v7's, and
 * `harness.manifest.json`'s): `sandbox: "any"` needs kind `virtual` or `pod`, `"pod"` needs a
 * pod, and each of `secrets` must be a declared slot. The API never sees `requires`, so the SDK
 * and the CLI check it while they compose.
 */
export function requirementGaps(
  requires: AgentManifest["requires"] | undefined,
  runtime: RuntimeSection | undefined,
): string[] {
  const gaps: string[] = [];
  if (!requires) return gaps;
  const kind = runtime?.kind ?? "none";
  const kindText = runtime === undefined ? "the manifest has no runtime section" : `the runtime is ${quoted(kind)}`;
  if (requires.sandbox === "any" && kind !== "virtual" && kind !== "pod")
    gaps.push(`requires.sandbox "any" needs runtime.kind "virtual" or "pod"; ${kindText}`);
  if (requires.sandbox === "pod" && kind !== "pod") gaps.push(`requires.sandbox "pod" needs runtime.kind "pod"; ${kindText}`);
  for (const name of requires.secrets ?? [])
    if (runtime?.secrets?.[name] === undefined)
      gaps.push(`requires.secrets ${quoted(name)} is not a secret slot in runtime.secrets`);
  return gaps;
}

/** `value` as agent manifest v8, or a `TypeError` naming every issue. */
function parseManifest(value: unknown): AgentManifestV8 {
  const parsed = AgentManifestV8Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const name = (value as { name?: unknown } | undefined)?.name;
  const issues = parsed.error.issues.map(
    (issue) => `  ${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`,
  );
  throw new TypeError(`Agent manifest${typeof name === "string" ? ` ${name}` : ""} is not valid:\n${issues.join("\n")}`);
}

function refuse(loop: AgentManifest | WorkflowManifest): void {
  const refusal = codeToolRefusal(loop) ?? approvalRefusal(loop);
  if (refusal) throw new Error(refusal);
}

/**
 * The agent manifest v8 document `input` describes, checked as the Runtime checks its schema:
 * a document with `manifestSchemaVersion` filled in and `$schema` dropped, or a built agent's
 * or flow's harness section with the name, runtime section and loop settings given.
 */
export function agentManifest(input: AgentManifestInput): AgentManifestV8 {
  return prepare(input).manifest;
}

function prepare(input: AgentManifestInput): {
  manifest: AgentManifestV8;
  files: Map<string, SkillFileSource>;
  gaps: string[];
} {
  if ("agent" in input) {
    const { agent } = input;
    const loop = agent.manifest as AgentManifest | WorkflowManifest;
    refuse(loop);
    // `harnessSectionOf` leaves out the loop manifest's identity and its `requires`, checked here.
    const section = harnessSectionOf(loop, input.harness === undefined ? {} : { harness: input.harness });
    if (input.memory !== undefined && "kind" in section)
      throw new TypeError(`memory turns on an agent's memory; ${agent.id} is a flow, whose harness section has none`);
    const skills = "kind" in section ? undefined : withSkillSecrets(agent as AgentSource, section.skills);
    const harness = {
      ...section,
      ...(skills === undefined ? {} : { skills }),
      ...(input.loop === undefined ? {} : { loop: input.loop }),
      ...(input.memory === undefined ? {} : { memory: input.memory }),
    };
    const description = input.description ?? loop.description;
    const metadata = input.metadata ?? loop.metadata;
    const manifest = parseManifest({
      manifestSchemaVersion: AGENT_MANIFEST_V8_SCHEMA_VERSION,
      name: input.name ?? agent.id,
      ...(description === undefined ? {} : { description }),
      ...(metadata === undefined ? {} : { metadata }),
      harness,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    });
    const requires = "kind" in loop ? undefined : loop.requires;
    return { manifest, files: skillFilesOf(agent), gaps: requirementGaps(requires, manifest.runtime) };
  }
  if ("files" in input && "gaps" in input) {
    const manifest = parseManifest(input.manifest);
    refuse(loopManifestOf(manifest));
    return { manifest, files: new Map(input.files), gaps: [...input.gaps] };
  }
  const { $schema: _, ...document } = input as AgentManifestDocument;
  const manifest = parseManifest({ manifestSchemaVersion: AGENT_MANIFEST_V8_SCHEMA_VERSION, ...document });
  refuse(loopManifestOf(manifest));
  return { manifest, files: new Map(), gaps: [] };
}

export class AgentManifestsClient {
  constructor(private readonly transport: Transport) {}

  private path(name: string): string {
    if (!isAgentManifestName(name))
      throw new TypeError(`${name} is not an agent manifest's name: 1-64 letters, digits, '.', '_' and '-'`);
    return `/v1/agent-manifests/${segment(name)}`;
  }

  private async send<T>(
    prepared: ReturnType<typeof prepare>,
    query: string,
    options: AgentManifestSaveOptions,
  ): Promise<T> {
    const { ifMatch, signal } = options;
    const path = this.path(prepared.manifest.name);
    const files = new Map(prepared.files);
    if (options.files instanceof Map) for (const [sha256, source] of options.files) files.set(sha256, source);
    else
      for (const [sha256, bytes] of Object.entries(options.files ?? {}))
        files.set(sha256, { size: bytes.byteLength, read: async () => bytes });
    // Its files by hash: uploaded first, each only when the Runtime does not hold it.
    await new FilesClient(this.transport).ensure(files, signal ? { signal } : {});
    const transport = ifMatch === undefined ? this.transport : this.transport.withHeaders({ "If-Match": String(ifMatch) });
    return transport.json<T>(`${path}${query}`, "PUT", { requestId: options.requestId ?? id(), ...prepared.manifest }, signal);
  }

  /**
   * Saves the manifest's next version (`PUT /v1/agent-manifests/{name}`), or answers the latest
   * unchanged; every Agent that tracks the manifest moves to it (track T3). Refused before anything is sent when it
   * misses its `requires` or, composed, its sections do not fit (`ManifestGapsError`).
   */
  async save(input: AgentManifestInput, options: AgentManifestSaveOptions = {}): Promise<SaveAgentManifestResponse> {
    const prepared = prepare(input);
    if (prepared.gaps.length > 0) throw new ManifestGapsError(prepared.manifest.name, prepared.gaps);
    return this.send(prepared, "", options);
  }

  /**
   * What saving the manifest would do (`?dryRun=true`): the version it would answer, each change
   * by section and path, warnings, errors, and the Agents on older versions. The gaps the SDK
   * finds itself are among `errors`. Its files are uploaded, since they are stored by content.
   */
  async plan(
    input: AgentManifestInput,
    options: Omit<AgentManifestSaveOptions, "requestId"> = {},
  ): Promise<AgentManifestPlan> {
    const prepared = prepare(input);
    const plan = await this.send<AgentManifestPlan>(prepared, "?dryRun=true", options);
    const errors = [...plan.errors, ...prepared.gaps.filter((gap) => !plan.errors.includes(gap))];
    return { ...plan, errors };
  }

  /** The latest version of manifest `name`, or version `version`. */
  async get(name: string, version?: number, options: { signal?: AbortSignal } = {}): Promise<AgentManifestView> {
    return this.transport.json(
      `${this.path(name)}${version === undefined ? "" : `/versions/${version}`}`,
      "GET",
      undefined,
      options.signal,
    );
  }

  /** Each manifest's latest version. */
  async list(options: { signal?: AbortSignal } = {}): Promise<AgentManifestView[]> {
    const reply = await this.transport.json<{ manifests: AgentManifestView[] }>(
      "/v1/agent-manifests",
      "GET",
      undefined,
      options.signal,
    );
    return reply.manifests;
  }

  /** Every version of manifest `name`, newest first, with how many Agents were made from each. */
  async versions(name: string, options: { signal?: AbortSignal } = {}): Promise<AgentManifestVersions> {
    return this.transport.json(`${this.path(name)}/versions`, "GET", undefined, options.signal);
  }

  /** Deletes every version; refused while an Agent was made from one (`409 manifest_in_use`). */
  async delete(name: string, options: { signal?: AbortSignal } = {}): Promise<DeleteAgentManifestResponse> {
    return this.transport.json(this.path(name), "DELETE", undefined, options.signal);
  }
}
