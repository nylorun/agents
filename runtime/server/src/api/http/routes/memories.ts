/**
 * An Agent's memories (track T5, D72), shaped like Anthropic's memory stores: list, read, write
 * whole, delete, and the versions every change leaves. A memory's path is relative to
 * `/memories`, with `/` percent-encoded (`conventions%2Frelease.md`), as an Agent id is. The
 * caller reaches an Agent's memories as it reaches the Agent; writes are `agents:write`.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { isAgentId, PutMemoryRequestSchema } from "@nylorun/core/contracts";
import { MemoryList, MemoryVersionDetail, MemoryVersionPage, MemoryView, PutMemoryRequest } from "../../components.js";
import { assertReaches } from "../../../tenant/agents.js";
import { fail } from "../../../tenant/http.js";
import {
  deleteMemoryPath,
  listMemories,
  listMemoryVersions,
  putMemoryContent,
  readMemory,
  readMemoryVersion,
} from "../../../tenant/memories.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { pageQuery, pageSize, parseQuery } from "./reads.js";
import { jsonResponse } from "../respond.js";

const READ: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own", "agents:read", "agents:write"],
};
const WRITE: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["agents:write"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const agentId = z.object({
  agentId: z.string().meta({ description: "The Agent id, percent-encoded" }),
});
const memoryPath = agentId.extend({
  path: z.string().meta({
    description: "The memory's path under `/memories`, percent-encoded: `conventions%2Frelease.md` is `/memories/conventions/release.md`",
  }),
});

function idOf(value: string | undefined): string {
  if (!isAgentId(value))
    return fail(400, "An Agent id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'");
  return value;
}

export function memoryRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/memories",
      tags: ["Memory"],
      summary: "List an Agent's memories",
      description:
        "Its memories by path, each with its size, `content_sha256`, frontmatter `description` and version. `pathPrefix` keeps one folder's (`conventions` for `/memories/conventions/…`).",
      request: {
        params: agentId,
        query: pageQuery.extend({
          pathPrefix: z.string().optional().meta({ description: "Only the memories in this folder, relative to `/memories`" }),
        }),
      },
      responses: { 200: json(MemoryList, "A page of memories") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      const pathPrefix = c.req.query("pathPrefix");
      const { limit, cursor } = parseQuery(pageQuery, { limit: c.req.query("limit"), cursor: c.req.query("cursor") });
      return jsonResponse(
        200,
        await listMemories(c.env.tenant, id, {
          ...(pathPrefix ? { pathPrefix } : {}),
          ...(cursor ? { cursor } : {}),
          limit: await pageSize(c.env.tenant, limit, { fallback: 100 }),
        }),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/memories/{path}",
      tags: ["Memory"],
      summary: "Read a memory",
      description: "The memory's content, with its size, `content_sha256`, description and version.",
      request: { params: memoryPath },
      responses: { 200: json(MemoryView, "The memory"), 404: { description: "No memory has this path" } },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await readMemory(c.env.tenant, id, c.req.param("path") ?? ""));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/agents/{agentId}/memories/{path}",
      tags: ["Memory"],
      summary: "Write a memory",
      description:
        "Creates the memory or replaces its content, as the `memory` tool's `create` does, and records a version with the caller as its actor. This is how an app seeds an Agent's memory. With `contentSha256` the write applies only while the memory still has that content (`\"\"`: only while no memory has the path); otherwise `409 memory_conflict` with the current memory. The path ends in `.md`; the Runtime limits `memoryBytes` (`413`) and `memoriesPerAgent` (`409 limit_exceeded`) hold.",
      request: {
        params: memoryPath,
        body: { required: true, content: { "application/json": { schema: PutMemoryRequest } } },
      },
      responses: {
        200: json(MemoryView, "The memory as written"),
        409: { description: "The `contentSha256` precondition no longer holds, or a folder has this path (`memory_conflict`)" },
        413: { description: "Larger than the Runtime limit `memoryBytes`" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      const body = PutMemoryRequestSchema.safeParse(await readJson(c));
      if (!body.success) fail(400, "The body is { content, contentSha256? }", { code: "invalid_request" });
      return jsonResponse(200, await putMemoryContent(c.env.tenant, id, c.req.param("path") ?? "", body.data!, scope));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/agents/{agentId}/memories/{path}",
      tags: ["Memory"],
      summary: "Delete a memory or a folder",
      description:
        "Deletes the memory, or every memory in the folder the path names, each with a version that records the delete. Versions stay with the Agent.",
      request: { params: memoryPath },
      responses: {
        200: json(z.object({ path: z.string(), deleted: z.number().int().nonnegative() }).strict(), "What was deleted"),
        404: { description: "No memory or folder has this path" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      return jsonResponse(200, await deleteMemoryPath(c.env.tenant, id, c.req.param("path") ?? "", scope));
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/memory_versions",
      tags: ["Memory"],
      summary: "List an Agent's memory versions",
      description:
        "Every change to its memories, newest first: the operation, the path (a rename's names its old one), and who made it: `agent:<manifest>@<version>` with the session, turn and trigger run of a turn's write, or the API caller. `path` keeps one memory's.",
      request: {
        params: agentId,
        query: pageQuery.extend({
          path: z.string().optional().meta({ description: "Only this memory's versions, relative to `/memories`" }),
        }),
      },
      responses: { 200: json(MemoryVersionPage, "A page of versions") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      const path = c.req.query("path");
      const { limit, cursor } = parseQuery(pageQuery, { limit: c.req.query("limit"), cursor: c.req.query("cursor") });
      return jsonResponse(
        200,
        await listMemoryVersions(c.env.tenant, id, {
          ...(path ? { path } : {}),
          ...(cursor ? { cursor } : {}),
          limit: await pageSize(c.env.tenant, limit, { fallback: 50 }),
        }),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/memory_versions/{versionId}",
      tags: ["Memory"],
      summary: "Read a memory version",
      description: "One version with the content it left (`null` for a delete). To roll a memory back, write this content again.",
      request: { params: agentId.extend({ versionId: z.string().meta({ description: "The version's id (`mv_…`)" }) }) },
      responses: { 200: json(MemoryVersionDetail, "The version"), 404: { description: "No such version" } },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await readMemoryVersion(c.env.tenant, id, c.req.param("versionId") ?? ""));
    },
  );
}
