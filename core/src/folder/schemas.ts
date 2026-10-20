/**
 * The JSON Schema document of each kind of file in an agent folder (track T7, design §3.10), so
 * an editor checks and completes a folder's files as it is written, from the `json.schemas`
 * mapping `nylorun init` writes. Each `$id` is `https://docs.nylorun.com/schemas/agent-folder/v1/
 * <kind>.json`; the build writes them to `dist/schemas/agent-folder/`, exported as
 * `@nylorun/core/schemas/agent-folder-<kind>.json`, and the docs site publishes each at its `$id`.
 *
 * - `runtime`, `tool`, `mcp` and `flow`: `runtime.json`, `tools/<name>.json`, `mcp.json` and
 *   `flow.json`, the `$schema` URLs the compiler takes (`SCHEMA_URLS`).
 * - `agent-md` and `trigger-md`: the frontmatter of `AGENT.md` and of `triggers/<id>.md`.
 *
 * They are built from what the compiler checks, so they cannot drift from it: its key lists name
 * each document's properties (a key left out or added is a type error here), and a value the
 * manifest takes as it is comes from the manifest's own zod schema (`runtime.json` from
 * `RuntimeSectionSchema`, `http` from `HttpToolTargetSchema`, `memory`, a trigger's fields). Where
 * the compiler refuses an unknown key, so does the document; `loop` and `metadata` stay open. A
 * document says less than the compiler only where JSON Schema cannot: that a path names a file of
 * the folder, a cron, a time zone, which server or skill a name means.
 */
import { z } from "zod";
import {
  AGENT_MANIFEST_NAME_PATTERN,
  ENVIRONMENT_NAME_PATTERN,
  HarnessIdSchema,
  HarnessMemorySchema,
  HttpToolTargetSchema,
  McpToolSettingsSchema,
  RuntimeSectionSchema,
  TOOL_SECRET_NAME_PATTERN,
  TriggerSchema,
} from "../contracts.js";
import { DELEGATE_NAME_PATTERN } from "../definition/delegate.js";
import {
  AGENT_KEYS,
  FOLDER_SCHEMAS,
  MCP_KEYS,
  PLUGIN_SERVER_SETTING_KEYS,
  SERVER_KEYS,
  TOOL_KEYS,
  TRIGGER_KEYS,
} from "./compile.js";
import { LOOP_KEYS, MAP_KEYS, NODE_KINDS, SWITCH_KEYS, VERIFY_KEYS } from "./flow.js";

/** The kinds of file an agent folder has a JSON Schema document for. */
export const AGENT_FOLDER_SCHEMA_KINDS = ["agent-md", "trigger-md", "runtime", "tool", "mcp", "flow"] as const;
export type AgentFolderSchemaKind = (typeof AGENT_FOLDER_SCHEMA_KINDS)[number];

type Json = Record<string, unknown>;
/** A document's properties: exactly the keys of `keys`, each with its schema. */
type Properties<Keys extends readonly string[]> = { [Key in Keys[number]]: Json };

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const ref = (name: string, description?: string): Json => ({ $ref: `#/$defs/${name}`, ...(description ? { description } : {}) });
/** A map whose keys are names matching `pattern`, each value `value`. */
const namedMap = (pattern: RegExp | undefined, value: Json, description: string): Json => ({
  type: "object",
  ...(pattern ? { propertyNames: { pattern: pattern.source } } : {}),
  additionalProperties: value,
  description,
});
const SCHEMA_KEY: Json = { type: "string", description: "This file's JSON Schema, for editors; the compiler leaves it out of the manifest" };

/**
 * A zod schema as JSON Schema (its input), without `$schema`, its `$defs` moved into `defs` so a
 * `$ref` in it still resolves once it sits inside a document.
 */
function fromZod(schema: z.ZodType, defs: Json, description?: string): Json {
  const { $schema: _, $defs, ...definition } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
  for (const [name, def] of Object.entries(($defs ?? {}) as Json)) {
    if (name in defs && JSON.stringify(defs[name]) !== JSON.stringify(def)) throw new Error(`Two schemas are named ${name} in one document`);
    defs[name] = def;
  }
  return description ? { ...definition, description } : definition;
}

/** One document: its `$id` from its kind, then the body, then the `$defs` its parts named. */
function document(kind: AgentFolderSchemaKind, title: string, description: string, body: Json, defs: Json): Json {
  return {
    $schema: DIALECT,
    $id: `${FOLDER_SCHEMAS}${kind}.json`,
    title,
    description,
    ...body,
    ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
  };
}

/** `inputSchema` and `outputSchema`: a JSON Schema inline, or the path of a schema file. */
const JSON_SCHEMA_OR_PATH: Json = {
  anyOf: [
    {
      type: "string",
      pattern: "\\.json$",
      description:
        "The path of a JSON Schema file in the folder (./output.schema.json; /schemas/x.json from the uploaded folder's root), named *.schema.json or kept under schemas/",
    },
    { type: "object", description: "A JSON Schema (2020-12), inline" },
  ],
};

function agentMd(): Json {
  const defs: Json = { JsonSchemaOrPath: JSON_SCHEMA_OR_PATH };
  const serverSettings: Properties<typeof PLUGIN_SERVER_SETTING_KEYS> = {
    deferred: { type: "boolean", description: "Offer the server's tools on demand, by search, instead of in every turn" },
    tools: namedMap(
      undefined,
      fromZod(McpToolSettingsSchema.omit({ approval: true }), defs),
      "Settings for each of the server's tools by name, \"*\" for the rest; approval is the Tenant's tool policy, not set here",
    ),
    credential: {
      type: "string",
      pattern: TOOL_SECRET_NAME_PATTERN.source,
      description: "The secret slot a plugin's server authenticates with, which the plugin cannot name; a server of mcp.json names it in a header",
    },
  };
  defs.McpServerSettings = { type: "object", properties: serverSettings, additionalProperties: false };
  const properties: Properties<typeof AGENT_KEYS> = {
    name: { type: "string", pattern: AGENT_MANIFEST_NAME_PATTERN.source, description: "The agent manifest's name, the folder's when it is saved under one" },
    description: { type: "string", minLength: 1, description: "What the agent does, in a sentence" },
    format: { const: 1, description: "The folder's format: 1 (agent-folder/1), the default" },
    harness: fromZod(HarnessIdSchema, defs, "The harness that runs the loop: nylorun (ours, the default) or a custom harness's id"),
    inputSchema: ref("JsonSchemaOrPath", "A flow's input (a folder with flow.json); an agent's input is the message"),
    outputSchema: ref("JsonSchemaOrPath", "The JSON Schema of the agent's final answer"),
    mcpServers: namedMap(DELEGATE_NAME_PATTERN, ref("McpServerSettings"), "How this agent uses each MCP server of mcp.json or a plugin, by its name"),
    skills: namedMap(
      undefined,
      {
        type: "object",
        properties: {
          secrets: {
            type: "array",
            items: { type: "string", pattern: ENVIRONMENT_NAME_PATTERN.source },
            description: "The secret slots the skill's scripts read, as environment variables",
          },
        },
        additionalProperties: false,
      },
      "This agent's settings for each skill of skills/ or a plugin, by its name",
    ),
    memory: fromZod(HarnessMemorySchema, defs, "The Agent's memory: Markdown files under /memories it keeps across sessions"),
    loop: { type: "object", description: "The harness's own settings, passed to it each turn; the nylorun harness reads none yet" },
    metadata: { type: "object", description: "The manifest's metadata, as it is" },
  };
  return document(
    "agent-md",
    "Nylorun agent folder: AGENT.md frontmatter",
    "The frontmatter of an agent folder's AGENT.md; the body below it is the instructions",
    { type: "object", properties, required: ["name", "description"], additionalProperties: false },
    defs,
  );
}

/** A trigger has exactly one of schedule, at and webhook (`TriggerSchema` refines it), and timezone goes with schedule. */
const ONE_TRIGGER_KIND: Json[] = [
  { required: ["schedule"] },
  { required: ["at"], properties: { timezone: false } },
  { required: ["webhook"], properties: { timezone: false } },
];

function triggerMd(): Json {
  const defs: Json = {};
  const fields = TriggerSchema.shape;
  const properties: Properties<typeof TRIGGER_KEYS> = {
    schedule: fromZod(fields.schedule, defs, "Five cron fields: minute hour day-of-month month day-of-week, in timezone"),
    timezone: fromZod(fields.timezone, defs, "The schedule's IANA time zone, such as Asia/Kolkata; UTC without one"),
    at: fromZod(fields.at, defs, "One run, at an RFC 3339 time with an offset"),
    webhook: fromZod(fields.webhook, defs, "A webhook endpoint, verified with this signature scheme"),
    session: fromZod(fields.session, defs, "The session each run goes to: a session id, or new for a new one per run"),
  };
  return document(
    "trigger-md",
    "Nylorun agent folder: trigger frontmatter",
    "The frontmatter of a trigger of an agent folder, triggers/<id>.md: exactly one of schedule, at and webhook, and the session; the body below it is the prompt",
    {
      type: "object",
      properties,
      required: ["session"],
      additionalProperties: false,
      oneOf: ONE_TRIGGER_KIND,
    },
    defs,
  );
}

function runtime(): Json {
  const defs: Json = {};
  const file = RuntimeSectionSchema.extend({ kind: RuntimeSectionSchema.shape.kind.optional() });
  const { properties, required, ...section } = fromZod(file, defs) as Json & { properties: Json; required?: string[] };
  // runtime.json's triggers are the manifest's, with what TriggerSchema refines.
  if (typeof defs.Trigger !== "object") throw new Error("runtime.json's schema has no Trigger");
  defs.Trigger = { ...(defs.Trigger as Json), oneOf: ONE_TRIGGER_KIND };
  return document(
    "runtime",
    "Nylorun agent folder: runtime.json",
    "An agent folder's runtime.json: the runtime section of the agent manifest. kind is required unless extends names a file that gives it",
    {
      ...section,
      properties: {
        $schema: SCHEMA_KEY,
        extends: {
          type: "string",
          minLength: 1,
          description:
            "The path of a shared runtime file, relative to this one, merged under it (this file's keys win: objects merge, arrays replace) by nylorun apply and packFolder before upload",
        },
        ...properties,
      },
      ...(required && required.length > 0 ? { required } : {}),
      anyOf: [{ required: ["kind"] }, { required: ["extends"] }],
    },
    defs,
  );
}

function tool(): Json {
  const defs: Json = { JsonSchemaOrPath: JSON_SCHEMA_OR_PATH };
  const properties: Properties<typeof TOOL_KEYS> = {
    description: { type: "string", description: "What the tool does, for the model" },
    inputSchema: ref("JsonSchemaOrPath", "The JSON Schema of the tool's input"),
    outputSchema: ref("JsonSchemaOrPath", "The JSON Schema of the tool's output"),
    http: fromZod(HttpToolTargetSchema, defs, "The request the tool makes; credential names the bearer slot it authenticates with"),
  };
  return document(
    "tool",
    "Nylorun agent folder: tools/<name>.json",
    "An HTTP tool of an agent folder, tools/<name>.json: its file name is the tool's name",
    { type: "object", properties: { $schema: SCHEMA_KEY, ...properties }, required: ["inputSchema", "http"], additionalProperties: false },
    defs,
  );
}

function mcp(): Json {
  const server: Properties<typeof SERVER_KEYS> = {
    type: { enum: ["streamable-http", "sse"], description: "The server's transport: the Runtime runs remote servers only" },
    url: { type: "string", minLength: 1, pattern: "^(?!.*\\$\\{)", description: "The server's URL; a credential goes in a header, never here" },
    headers: namedMap(
      undefined,
      { type: "string" },
      'Headers sent to the server. "Bearer ${NAME}" in Authorization, or "${NAME}" alone in another header, names the secret slot the server authenticates with',
    ),
  };
  const properties: Properties<typeof MCP_KEYS> = {
    $schema: { ...SCHEMA_KEY, description: "This file's JSON Schema, for editors: ours, or Agent Plugins' MCP schema" },
    mcpServers: namedMap(DELEGATE_NAME_PATTERN, ref("McpServer"), "The MCP servers, by name"),
  };
  return document(
    "mcp",
    "Nylorun agent folder: mcp.json",
    "An agent folder's MCP servers, in Agent Plugins syntax",
    { type: "object", properties, required: ["mcpServers"], additionalProperties: false },
    { McpServer: { type: "object", properties: server, required: ["type", "url"], additionalProperties: false } },
  );
}

function flow(): Json {
  const node = ref("Node");
  const id: Json = { type: "string", minLength: 1, description: "The node's id, which names its step in a run" };
  const leaf = (description: string): Json => ({ type: "string", minLength: 1, description });
  const switchKeys: Properties<typeof SWITCH_KEYS> = {
    cases: namedMap(undefined, node, "The node each route runs, by route"),
    default: { ...node, description: "The node that runs when no route matches" },
  };
  const loopKeys: Properties<typeof LOOP_KEYS> = {
    run: { ...node, description: "The node each attempt runs" },
    verify: ref("Verifier"),
    max: { type: "integer", minimum: 1, description: "The most attempts the loop makes" },
  };
  const verifyKeys: Properties<typeof VERIFY_KEYS> = {
    agent: leaf("An agent of the flow root's agents/, by its id, that judges each attempt"),
    tool: leaf("A tool of tools/ beside this flow.json, by its name, that judges each attempt"),
    id,
  };
  const bodies: { [Kind in (typeof NODE_KINDS)[number]]: Json } = {
    agent: leaf("An agent of the flow root's agents/, by its id"),
    tool: leaf("A tool of tools/ beside this flow.json, by its name (tools/<name>.json)"),
    chain: { type: "array", items: node, minItems: 1, description: "Nodes run in order, each given the one before's output" },
    switch: { type: "object", properties: switchKeys, required: ["cases"], additionalProperties: false, description: "Runs the node of the route the input names" },
    parallel: { type: "object", additionalProperties: node, minProperties: 1, description: "Runs each branch's node at once, by branch name" },
    map: { type: "object", properties: { each: node } satisfies Properties<typeof MAP_KEYS>, required: ["each"], additionalProperties: false, description: "Runs the node once per item of its input" },
    loop: { type: "object", properties: loopKeys, required: ["run", "verify", "max"], additionalProperties: false, description: "Runs a node until verify passes it, up to max attempts" },
  };
  const pascal = (kind: string) => `${kind[0]!.toUpperCase()}${kind.slice(1)}Node`;
  const defs: Json = {
    Node: { oneOf: NODE_KINDS.map((kind) => ref(pascal(kind))), description: `A node: exactly one of ${NODE_KINDS.join(", ")}, and an optional id` },
  };
  for (const kind of NODE_KINDS) defs[pascal(kind)] = { type: "object", properties: { [kind]: bodies[kind], id }, required: [kind], additionalProperties: false };
  // The file's own node may also name this schema; a node inside it may not.
  const root: Json = {
    oneOf: NODE_KINDS.map((kind) => ({ type: "object", properties: { $schema: SCHEMA_KEY, [kind]: bodies[kind], id }, required: [kind], additionalProperties: false })),
  };
  defs.Verifier = {
    oneOf: [
      { type: "object", properties: { agent: verifyKeys.agent, id: verifyKeys.id }, required: ["agent"], additionalProperties: false },
      { type: "object", properties: { tool: verifyKeys.tool }, required: ["tool"], additionalProperties: false },
    ],
    description: "What judges each attempt: an agent, or an HTTP tool",
  };
  return document(
    "flow",
    "Nylorun agent folder: flow.json",
    "A flow's node tree (workflow manifest v3's), naming agents of the flow root's agents/ by id and tools beside the file by name",
    root,
    defs,
  );
}

const BUILD: Record<AgentFolderSchemaKind, () => Json> = {
  "agent-md": agentMd,
  "trigger-md": triggerMd,
  runtime,
  tool,
  mcp,
  flow,
};

/**
 * The JSON Schema document (2020-12) of each kind of file in an agent folder, by kind, as the
 * build writes them (`dist/schemas/agent-folder/<kind>.schema.json`).
 */
export function agentFolderJsonSchemas(): Record<AgentFolderSchemaKind, Record<string, unknown>> {
  return Object.fromEntries(AGENT_FOLDER_SCHEMA_KINDS.map((kind) => [kind, BUILD[kind]()])) as Record<AgentFolderSchemaKind, Record<string, unknown>>;
}
