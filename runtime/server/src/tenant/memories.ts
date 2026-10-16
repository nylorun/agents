/**
 * An Agent's memories over the Runtime API (track T5, D72), shaped like Anthropic's memory stores:
 * list and read them, write one whole (create or replace, with an optional `content_sha256`
 * precondition), delete one or a folder, and read the versions every change leaves. Writes go
 * through the memory service (`memory/service.ts`), as a model's do, so the same paths, limits
 * and versions hold; the actor is the caller (`human:<subject>`, else `application`).
 */
import {
  memoryPathOf,
  type Memory,
  type MemoryList,
  type MemoryVersionDetail,
  type MemoryVersionPage,
  type PutMemoryRequest,
} from "@nylorun/core/contracts";
import {
  applyMemoryCommand,
  memorySummaryOf,
  memoryVersionDetailOf,
  memoryVersionOf,
  type MemoryRefused,
} from "../memory/service.js";
import type { Tx } from "../store/types.js";
import { liveEnvironment } from "./agents.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail } from "./http.js";
import { readRuntimeLimits } from "./runtime-limits.js";

/** Who an API write names: the person a request acts for, else the application. */
export function memoryActorOf(scope: AuthScope): string {
  return scope.kind === "token" || scope.kind === "subject" ? `human:${scope.subject}` : "application";
}

async function agentOf(t: Tx, agentId: string): Promise<void> {
  if (!(await liveEnvironment(t, agentId))) fail(404, `Agent ${agentId} not found`, { code: "not_found" });
}

/** A path from a route: relative to `/memories` (as the route's segment), or absolute. */
function routePath(raw: string, kind: "file" | "any"): string {
  const trimmed = raw.replace(/^\/+/, "");
  const parsed = memoryPathOf(trimmed.startsWith("memories/") || trimmed === "memories" ? trimmed : `memories/${trimmed}`, kind);
  return "error" in parsed ? fail(400, parsed.error, { code: "invalid_request" }) : parsed.path;
}

/** The HTTP answer to a refused write. */
function refusal(result: MemoryRefused): never {
  switch (result.code) {
    case "memory.not_found":
      return fail(404, result.text, { code: "not_found" });
    case "memory.limit":
      return fail(409, result.text, { code: "limit_exceeded", details: { limit: "memoriesPerAgent" } });
    case "memory.too_large":
      return fail(413, result.text, { code: "limit_exceeded", details: { limit: "memoryBytes" } });
    case "memory.exists":
      return fail(409, result.text, { code: "memory_conflict" });
    default:
      return fail(400, result.text, { code: "invalid_request" });
  }
}

/** `GET /v1/agents/{id}/memories`: the Agent's memories by path, under `pathPrefix` when given. */
export async function listMemories(
  ctx: TenantContext,
  agentId: string,
  options: { pathPrefix?: string; cursor?: string; limit: number },
): Promise<MemoryList> {
  const folder = options.pathPrefix === undefined ? undefined : routePath(options.pathPrefix, "any");
  return ctx.store.tx(async (t) => {
    await agentOf(t, agentId);
    const rows = await t.memories(agentId, {
      ...(folder === undefined ? {} : { folder }),
      ...(options.cursor === undefined ? {} : { after: options.cursor }),
      limit: options.limit + 1,
    });
    const page = rows.slice(0, options.limit);
    return { memories: page.map(memorySummaryOf), nextCursor: rows.length > options.limit ? page.at(-1)!.path : null };
  });
}

/** `GET /v1/agents/{id}/memories/{path}`: one memory with its content. */
export async function readMemory(ctx: TenantContext, agentId: string, rawPath: string): Promise<Memory> {
  const path = routePath(rawPath, "file");
  return ctx.store.tx(async (t) => {
    await agentOf(t, agentId);
    const row = (await t.memory(agentId, path)) ?? fail(404, `The path ${path} does not exist`, { code: "not_found" });
    return { ...memorySummaryOf(row), content: row.content };
  });
}

/**
 * `PUT /v1/agents/{id}/memories/{path}`: writes the memory whole, as the tool's `create` does. With
 * `contentSha256` the write applies only while the memory still has that content (`""`: only while
 * no memory has the path); otherwise `409 memory_conflict` with the current memory.
 */
export async function putMemoryContent(
  ctx: TenantContext,
  agentId: string,
  rawPath: string,
  body: PutMemoryRequest,
  scope: AuthScope,
): Promise<Memory> {
  const path = routePath(rawPath, "file");
  return ctx.store.tx(async (t) => {
    await agentOf(t, agentId);
    const current = await t.memory(agentId, path, { lock: true });
    if (body.contentSha256 !== undefined && body.contentSha256 !== (current?.contentSha256 ?? ""))
      fail(409, `${path} has changed since that content_sha256: read it again and write on top of what it holds now.`, {
        code: "memory_conflict",
        details: { current: current ? { ...memorySummaryOf(current), content: current.content } : null },
      });
    const result = await applyMemoryCommand(
      t,
      agentId,
      { command: "create", path, fileText: body.content },
      { actor: memoryActorOf(scope) },
      await readRuntimeLimits(t),
    );
    if (!result.ok) refusal(result);
    const row = (await t.memory(agentId, path))!;
    return { ...memorySummaryOf(row), content: row.content };
  });
}

/** `DELETE /v1/agents/{id}/memories/{path}`: deletes a memory, or every memory in a folder. */
export async function deleteMemoryPath(
  ctx: TenantContext,
  agentId: string,
  rawPath: string,
  scope: AuthScope,
): Promise<{ path: string; deleted: number }> {
  const path = routePath(rawPath, "any");
  return ctx.store.tx(async (t) => {
    await agentOf(t, agentId);
    const result = await applyMemoryCommand(
      t,
      agentId,
      { command: "delete", path },
      { actor: memoryActorOf(scope) },
      await readRuntimeLimits(t),
    );
    if (!result.ok) refusal(result);
    return { path, deleted: result.changes.length };
  });
}

/** `GET /v1/agents/{id}/memory_versions`: versions, newest first; `path` keeps one path's. */
export async function listMemoryVersions(
  ctx: TenantContext,
  agentId: string,
  options: { path?: string; cursor?: string; limit: number },
): Promise<MemoryVersionPage> {
  const path = options.path === undefined ? undefined : routePath(options.path, "file");
  return ctx.store.tx(async (t) => {
    await agentOf(t, agentId);
    const rows = await t.memoryVersions(agentId, {
      ...(path === undefined ? {} : { path }),
      ...(options.cursor === undefined ? {} : { before: options.cursor }),
      limit: options.limit + 1,
    });
    const page = rows.slice(0, options.limit);
    return { versions: page.map(memoryVersionOf), nextCursor: rows.length > options.limit ? page.at(-1)!.id : null };
  });
}

/** `GET /v1/agents/{id}/memory_versions/{versionId}`: one version with the content it left. */
export async function readMemoryVersion(ctx: TenantContext, agentId: string, versionId: string): Promise<MemoryVersionDetail> {
  return ctx.store.tx(async (t) => {
    await agentOf(t, agentId);
    const row = (await t.memoryVersion(agentId, versionId)) ?? fail(404, `Memory version ${versionId} not found`, { code: "not_found" });
    return memoryVersionDetailOf(row);
  });
}
