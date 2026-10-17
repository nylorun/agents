/**
 * A session's MCP discovery (protocol 15), in two shapes:
 *
 * - the **snapshot** (`McpSnapshotSchema`): what the session's remote MCP servers said at
 *   discovery, as they said it (raw tool names, schemas and instructions, credential values
 *   scrubbed). A harness records it once per session (`session.mcp`, the first recorded wins), and
 *   the Runtime keeps it pinned on the session;
 * - the **facts** (`McpFactsSchema`): the snapshot as one turn sees it, in `turn.start.mcp` and the
 *   `session.mcp` answer. Each tool says whether the turn's manifest leaves it `enabled` (the
 *   record refuses a call of one it does not, `tool.disabled`) and whether the manifest asks for it
 *   to be `deferred` (a hint; absent, the harness decides).
 *
 * The harness names each tool for the model (Nylorun's engine: `server__tool`, within 64
 * characters), decides which to defer, and calls one by its identity: an effect's target
 * `{kind: "mcp", server, tool}`, and the Tool Gate's body `{server: {agentId?, serverName}, name}`.
 */
import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());

/** One tool a server listed, as it listed it. */
export const McpToolRecordSchema = z.object({
  /** The tool's name on its server: what the call sends, and its identity. */
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: jsonObject,
  outputSchema: jsonObject.optional(),
  /** The server's annotations of the tool (`readOnlyHint`, `idempotentHint`, `title`, …). */
  annotations: jsonObject.optional(),
});

/** One server that connected at discovery, with what it said. */
export const McpServerRecordSchema = z.object({
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  agentId: z.string().optional(),
  name: z.string().min(1),
  /** The server's own instructions (MCP `initialize`), scrubbed and uncut. */
  instructions: z.string().optional(),
  tools: z.array(McpToolRecordSchema).readonly(),
});

export const McpSnapshotSchema = z.object({
  snapshotSchemaVersion: z.literal(2),
  manifestHash: z.string(),
  servers: z.array(McpServerRecordSchema).readonly(),
});

/** One tool of a server, as a turn sees it. */
export const McpToolFactSchema = McpToolRecordSchema.extend({
  /** False when the turn's manifest disables it: the record refuses its calls. */
  enabled: z.boolean(),
  /** The manifest's `deferred` setting of the tool; absent, the harness decides. */
  deferred: z.boolean().optional(),
});

export const McpServerFactSchema = z.object({
  agentId: z.string().optional(),
  name: z.string().min(1),
  instructions: z.string().optional(),
  tools: z.array(McpToolFactSchema).readonly(),
});

export const McpFactsSchema = z.object({ servers: z.array(McpServerFactSchema).readonly() });

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type McpToolRecord = DeepReadonly<z.infer<typeof McpToolRecordSchema>>;
export type McpServerRecord = DeepReadonly<z.infer<typeof McpServerRecordSchema>>;
export type McpSnapshot = DeepReadonly<z.infer<typeof McpSnapshotSchema>>;
export type McpToolFact = DeepReadonly<z.infer<typeof McpToolFactSchema>>;
export type McpServerFact = DeepReadonly<z.infer<typeof McpServerFactSchema>>;
export type McpFacts = DeepReadonly<z.infer<typeof McpFactsSchema>>;
