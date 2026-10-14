/**
 * A session's MCP snapshot (R4.5): the tools its remote MCP servers listed, recorded once per
 * session (`session.mcp`, the first recorded wins) and handed to every run in
 * `TurnStart.routing.mcpSnapshot`. A harness offers the model exactly these tools (those not
 * `deferred`) and calls one through the Tool Gate by its server and `serverToolName`.
 */
import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());

export const McpToolRecordSchema = z.object({
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  agentId: z.string().optional(),
  serverName: z.string(),
  /** The tool's name on its server, which the call sends. */
  serverToolName: z.string(),
  /** The name the model knows it by. */
  name: z.string(),
  description: z.string().optional(),
  inputSchema: jsonObject,
  outputSchema: jsonObject.optional(),
  /** The server's hints that calling the tool again is safe. */
  annotations: z
    .object({ readOnlyHint: z.boolean().optional(), idempotentHint: z.boolean().optional() })
    .optional(),
  /** Out of the model's tool list for the session's life; found through the deferred-tools tool. */
  deferred: z.literal(true).optional(),
});

/** A server's own instructions (MCP `initialize`), for the note on its deferred tools. */
export const McpServerNoteSchema = z.object({
  agentId: z.string().optional(),
  serverName: z.string(),
  instructions: z.string(),
});

export const McpSnapshotSchema = z.object({
  snapshotSchemaVersion: z.literal(1),
  manifestHash: z.string(),
  mcpTools: z.array(McpToolRecordSchema).readonly(),
  /** The servers that gave instructions; absent when none did. */
  servers: z.array(McpServerNoteSchema).readonly().optional(),
});

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type McpToolRecord = DeepReadonly<z.infer<typeof McpToolRecordSchema>>;
export type McpServerNote = DeepReadonly<z.infer<typeof McpServerNoteSchema>>;
export type McpSnapshot = DeepReadonly<z.infer<typeof McpSnapshotSchema>>;
