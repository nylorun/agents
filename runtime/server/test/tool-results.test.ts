/**
 * R2b C11 end to end over the Tenant API: MCP and HTTP tool results that fit. A result too large
 * to show becomes an artifact of the session and the model gets a preview, which it reads on with
 * `read_artifact`; an image becomes an artifact and goes to the model as a file; each part of a
 * mixed result is shaped alone; an answer past 8 MiB (the Tenant's `toolAnswerBytes`) is
 * `mcp.too-large`, as one past a lowered limit is, or `http.too-large`; and no event of the
 * session's record passes 64 KiB. With `NYLORUN_TEST_MODEL_GATE=http` the gates service makes
 * every call; otherwise the Tenant does, in process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, http, type AgentsClient } from "@nylorun/agents";
import { RUNTIME_LIMIT_DEFAULTS, type LiveEvent } from "@nylorun/core/contracts";
import type { ModelCall, PromptContentPart } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "tool-results-app-key-aaaaaaaaaaaa";
const KiB = 1024;
const EVENT_MAX = 64 * KiB;

/** About 200 KiB of lines, with two- and three-byte characters for the page boundaries. */
const BIG = Array.from({ length: 3_100 }, (_, i) => `line ${String(i).padStart(5, "0")} é€ ${"x".repeat(50)}\n`).join("");
/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4 not really a pdf").toString("base64");
const RECORDS = Array.from({ length: 1_500 }, (_, id) => ({ id, note: `record ${id} ${"n".repeat(50)}` }));
/** 30 KiB of text, its own for each `n`: under the inline cap alone, too much forty at a time. */
const chunk = (n: number) => `chunk ${n} `.padEnd(30 * 1024, String.fromCharCode(97 + (n % 26)));
const REPORT = { rows: Array.from({ length: 1_500 }, (_, id) => ({ id, value: "v".repeat(60) })) };

/** A remote MCP server whose tools answer as their names say. */
async function mcpServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    const mcp = new McpServer({ name: "files", version: "0.0.0" });
    const none = {};
    mcp.registerTool("big_text", { description: "A long text.", inputSchema: none }, async () => ({
      content: [{ type: "text", text: BIG }],
    }));
    mcp.registerTool("screenshot", { description: "A screenshot.", inputSchema: none }, async () => ({
      content: [
        { type: "text", text: "the page" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    }));
    mcp.registerTool("mixed", { description: "Everything.", inputSchema: none }, async () => ({
      content: [
        { type: "text", text: "summary" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "resource_link", uri: "https://files.example/report", name: "report" },
        { type: "resource", resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: PDF } },
        { type: "text", text: BIG.slice(0, 100 * KiB) },
      ],
    }));
    mcp.registerTool(
      "records",
      {
        description: "Records.",
        inputSchema: none,
        outputSchema: { items: z.array(z.object({ id: z.number(), note: z.string() })) },
      },
      async () => ({
        content: [{ type: "text", text: "records" }],
        structuredContent: { items: RECORDS },
      }),
    );
    mcp.registerTool("chunk", { description: "30 KiB.", inputSchema: { n: z.number() } }, async ({ n }) => ({
      content: [{ type: "text", text: chunk(n) }],
    }));
    mcp.registerTool("huge", { description: "Too much.", inputSchema: none }, async () => ({
      content: [{ type: "text", text: "h".repeat(9 * KiB * KiB) }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await listen(server);
  return { url: `${origin(server)}/mcp` };
}

/** An HTTP tool's service answering a report of about 100 KiB. */
async function reportService() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(REPORT));
  });
  await listen(server);
  return { url: origin(server) };
}

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
}
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** A tool result the model saw: its status, its JSON and the files beside it. */
interface Seen {
  readonly status: string;
  readonly payload: any;
  readonly media: Extract<PromptContentPart, { type: "media" }>[];
}

type Call = { name: string; args: Record<string, unknown> };
/** What the model does next, given the result it just saw (none on its first step): calls in parallel. */
let brain: (seen: Seen | undefined) => Call | Call[] | undefined = () => undefined;
let offered: string[] = [];
/** Every tool result in the model's last prompt. */
let results: Seen[] = [];
let calls = 0;
/** The user message of the turn's files the call ends with, after the conversation (protocol 12). */
const filesMessage = (prompt: ModelCall["prompt"]) => {
  const last = prompt.at(-1);
  const first = last?.content[0];
  return last?.kind === "message" && first?.type === "text" && first.text === "Files for this turn:"
    ? last
    : undefined;
};
/**
 * The turn's files: the media of that message, each labelled with the reference line its tool
 * result holds. A text file is inlined there, and a file the model does not read is a note
 * (protocol 15): neither is media.
 */
const turnFiles = (prompt: ModelCall["prompt"]): Seen["media"] =>
  (filesMessage(prompt)?.content.filter((part) => part.type === "media") ?? []) as Seen["media"];
const seenOf = (
  item: Extract<ModelCall["prompt"][number], { kind: "tool-result" }>,
  files: Seen["media"],
): Seen => {
  const [payload, ...lines] = item.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  return {
    status: item.status,
    payload: JSON.parse(payload!),
    media: files.filter((file) =>
      lines.some((line) => line.includes(` · ${(file.reference as { artifactId: string }).artifactId} v`)),
    ),
  };
};
/** The last call's prompt. */
let lastPrompt: ModelCall["prompt"] | undefined;
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as ModelCall;
  lastPrompt = input.prompt;
  offered = input.tools.map((tool) => tool.name);
  const files = turnFiles(input.prompt);
  const conversation = filesMessage(input.prompt) ? input.prompt.slice(0, -1) : input.prompt;
  results = conversation.flatMap((item) => (item.kind === "tool-result" ? [seenOf(item, files)] : []));
  const last = conversation.at(-1);
  const next = brain(last?.kind === "tool-result" ? seenOf(last, files) : undefined);
  if (!next) return { output: [{ type: "text", text: "done" }] };
  return {
    output: (Array.isArray(next) ? next : [next]).map((call) => {
      calls += 1;
      return { type: "tool-call", id: `call-${calls}`, name: call.name, args: call.args };
    }),
  };
};

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
let runtime: Runtime;
let client: AgentsClient;

let sessions = 0;
/** Opens a session of `agentId`, runs one turn and returns what it recorded. */
async function run(agentId = "reader") {
  sessions += 1;
  const id = `results-${sessions}`;
  const session = await client.createSession({ id, agentId, ownerUserId: "u:ada" });
  await session.input("go", { idempotencyKey: `m${sessions}` });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status)) {
      const history = await session.history();
      const items = history.items as { type: string; payload: Record<string, any> }[];
      // Every event of the session's record, the internal ones (transcript.updated) included.
      const recorded = await withTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId }, async (store) =>
        (await store.record().readRange(runtime.tenantId, id, 0, Number.MAX_SAFE_INTEGER)).map(
          (record) => record.body as LiveEvent,
        ),
      );
      return {
        id,
        status: view.status,
        completed: items.filter((item) => item.type === "tool.completed").map((item) => item.payload),
        created: items.filter((item) => item.type === "artifact.created").map((item) => item.payload),
        recorded,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

/**
 * The largest entry of a session's record, in bytes: a transcript edit's largest entry (an edit
 * fills its event up to the record entry limit, B15), else the event.
 */
const largest = (recorded: readonly LiveEvent[]) =>
  Math.max(
    ...recorded.flatMap((event) =>
      event.type === "transcript.updated"
        ? (event.payload as { entries: unknown[] }).entries.map((entry) => Buffer.byteLength(JSON.stringify(entry)))
        : [Buffer.byteLength(JSON.stringify(event))],
    ),
  );

async function download(artifactId: string): Promise<Buffer> {
  const response = await fetch(`${runtime.url}/v1/artifacts/${artifactId}/versions/latest/content`, {
    headers: { authorization: `Bearer ${APP}` },
  });
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

/** The model calls `name` once, keeps what it saw, then answers. */
function once(name: string): Seen[] {
  const seen: Seen[] = [];
  brain = (result) => {
    if (!result) return { name, args: {} };
    seen.push(result);
    return undefined;
  };
  return seen;
}

beforeAll(async () => {
  const [files, report] = await Promise.all([mcpServer(), reportService()]);
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  const put = async (agent: { manifest: unknown }) => {
    const id = (agent.manifest as { id: string }).id;
    const response = await fetch(`${runtime.url}/v1/agents/${id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: `put-${id}`, manifest: agent.manifest, implementationVersion: "dev" }),
    });
    expect(response.ok).toBe(true);
  };
  await put(
    Agent({ id: "reader" })
      .mcp({ files: { type: "streamable-http", url: files.url } })
      .tools(http({ name: "report", input: z.object({}), url: `${report.url}/report` }))
      .build(),
  );
  await put(Agent({ id: "plain" }).instructions("Answer.").build());
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

describe("a result too large to show (Q22)", () => {
  it("stores 200 KiB of text as an artifact, previews it, and read_artifact pages through it", async () => {
    const pages: string[] = [];
    const seen: Seen[] = [];
    let artifactId = "";
    brain = (result) => {
      if (!result) return { name: "files__big_text", args: {} };
      seen.push(result);
      if (result.payload.truncated) {
        artifactId = result.payload.artifactId;
        return { name: "read_artifact", args: { artifactId } };
      }
      pages.push(result.payload.content);
      return result.payload.nextOffset === undefined
        ? undefined
        : { name: "read_artifact", args: { artifactId, offset: result.payload.nextOffset } };
    };
    const result = await run();
    expect(result.status).toBe("completed");
    const size = Buffer.byteLength(BIG);
    expect(size).toBeGreaterThan(200 * KiB);

    // The model saw the preview: the first 4 KiB and the last 1 KiB.
    const first = seen[0]!;
    expect(first.status).toBe("completed");
    expect(first.payload).toEqual({
      truncated: true,
      artifactId: expect.stringMatching(/^af_/),
      version: 1,
      contentType: "text/plain; charset=utf-8",
      size,
      preview: expect.any(String),
    });
    const preview = first.payload.preview as string;
    expect(preview.startsWith(BIG.slice(0, 3_500))).toBe(true);
    expect(preview.endsWith(BIG.slice(-900))).toBe(true);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(5 * KiB + 8);
    expect(preview).not.toContain("�");

    // Pages of at most 32 KiB, in whole characters, that put the result back together.
    expect(pages.length).toBeLessThanOrEqual(Math.ceil(size / (31 * KiB)));
    for (const page of seen.slice(1)) expect(Buffer.byteLength(page.payload.content)).toBeLessThanOrEqual(32 * KiB);
    expect(pages.join("")).toBe(BIG);
    expect(seen.at(-1)!.payload.nextOffset).toBeUndefined();

    // The artifact is the session's, made by the call, and holds the whole result.
    expect(result.created).toEqual([
      expect.objectContaining({ artifactId, source: "engine", size, callId: "call-1" }),
    ]);
    expect((await download(artifactId)).toString("utf8")).toBe(BIG);
    expect(result.completed[0]).toMatchObject({ toolName: "files__big_text", output: { truncated: true, artifactId } });
    expect(largest(result.recorded)).toBeLessThan(EVENT_MAX);
  });

  it("stores a structured result past the cap without checking it against the output schema", async () => {
    const seen = once("files__records");
    const result = await run();
    expect(seen[0]!.status).toBe("completed");
    expect(seen[0]!.payload).toMatchObject({ truncated: true, contentType: "application/json" });
    expect(JSON.parse((await download(seen[0]!.payload.artifactId)).toString("utf8"))).toEqual({ items: RECORDS });
    expect(largest(result.recorded)).toBeLessThan(EVENT_MAX);
  });

  it("shapes an HTTP tool's answer the same way", async () => {
    const seen = once("report");
    const result = await run();
    expect(seen[0]!.payload).toMatchObject({ truncated: true, contentType: "application/json" });
    expect(JSON.parse((await download(seen[0]!.payload.artifactId)).toString("utf8"))).toEqual(REPORT);
    expect(result.completed[0]).toMatchObject({ toolName: "report", output: { truncated: true } });
    expect(largest(result.recorded)).toBeLessThan(EVENT_MAX);
  });
});

describe("images and other files (Q23)", () => {
  it("stores a PNG as an artifact and gives it to the model as a file", async () => {
    const seen = once("files__screenshot");
    const result = await run();
    const [image] = result.created;
    expect(image).toMatchObject({ contentType: "image/png", source: "engine", name: "files__screenshot-result-2.png" });
    expect(seen[0]!.payload).toEqual([
      { type: "text", text: "the page" },
      { type: "image", artifactId: image!.artifactId, version: 1, contentType: "image/png", size: 70 },
    ]);
    expect(seen[0]!.media).toEqual([
      {
        type: "media",
        mediaType: "image/png",
        reference: { artifactId: image!.artifactId, version: 1, name: "files__screenshot-result-2.png", size: 70 },
      },
    ]);
    expect((await download(image!.artifactId)).toString("base64")).toBe(PNG);
    // No image bytes in the record: the transcript and the events hold the reference.
    expect(JSON.stringify(result.recorded)).not.toContain(PNG.slice(0, 40));
  });

  it("shapes each part of a mixed result", async () => {
    const seen = once("files__mixed");
    const result = await run();
    const parts = seen[0]!.payload as Record<string, unknown>[];
    expect(parts).toEqual([
      { type: "text", text: "summary" },
      { type: "image", artifactId: expect.any(String), version: 1, contentType: "image/png", size: 70 },
      { type: "resource_link", uri: "https://files.example/report", name: "report" },
      {
        type: "resource",
        uri: "file:///report.pdf",
        artifactId: expect.any(String),
        version: 1,
        contentType: "application/pdf",
        size: Buffer.from(PDF, "base64").byteLength,
      },
      {
        type: "text",
        truncated: true,
        artifactId: expect.any(String),
        version: 1,
        contentType: "text/plain; charset=utf-8",
        size: Buffer.byteLength(BIG.slice(0, 100 * KiB)),
        preview: expect.any(String),
      },
    ]);
    expect(seen[0]!.media).toHaveLength(1);
    expect(result.created.map((item) => item.contentType)).toEqual([
      "image/png",
      "application/pdf",
      "text/plain; charset=utf-8",
    ]);
    expect((await download(parts[4]!.artifactId as string)).toString("utf8")).toBe(BIG.slice(0, 100 * KiB));
    expect(Buffer.byteLength(JSON.stringify(parts))).toBeLessThan(32 * KiB);
    expect(largest(result.recorded)).toBeLessThan(EVENT_MAX);
  });
});

describe("the gate's cap", () => {
  it("an MCP answer past 8 MiB is mcp.too-large", async () => {
    const seen = once("files__huge");
    const result = await run();
    expect(result.status).toBe("completed");
    expect(seen[0]!.status).toBe("failed");
    expect(seen[0]!.payload).toMatchObject({ kind: "failed", code: "mcp.too-large", retryable: false });
    expect(result.completed[0]).toMatchObject({ error: { code: "mcp.too-large", retryable: false } });
    expect(result.created).toEqual([]);
    expect(largest(result.recorded)).toBeLessThan(EVENT_MAX);
  });

  it("holds MCP and HTTP answers to the Tenant's toolAnswerBytes once it lowers it", async () => {
    const limits = (body: unknown) =>
      fetch(`${runtime.url}/v1/tenant/limits`, {
        method: "PUT",
        headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await limits({ limits: { toolAnswerBytes: 64 * KiB } })).status).toBe(200);
    try {
      const mcp = once("files__big_text");
      await run();
      expect(mcp[0]!.payload).toMatchObject({
        kind: "failed",
        code: "mcp.too-large",
        message: expect.stringContaining(`more than ${64 * KiB} bytes`),
      });
      const report = once("report");
      await run();
      expect(report[0]!.payload).toMatchObject({
        kind: "failed",
        code: "http.too-large",
        message: expect.stringContaining(`larger than ${64 * KiB} bytes`),
      });
    } finally {
      expect((await limits({})).status).toBe(200);
    }
  });
});

describe("read_artifact (Q24)", () => {
  it("is offered to every agent (protocol 12)", async () => {
    once("files__screenshot");
    await run();
    expect(offered).toContain("read_artifact");
    brain = () => undefined;
    await run("plain");
    expect(offered).toContain("read_artifact");
  });

  it("reads only the session's own artifacts", async () => {
    const theirs = once("files__screenshot");
    await run();
    const artifactId = theirs[0]!.payload[1].artifactId as string;
    const seen: Seen[] = [];
    brain = (result) => {
      if (!result) return { name: "read_artifact", args: { artifactId } };
      seen.push(result);
      return undefined;
    };
    await run();
    expect(seen[0]!.payload).toMatchObject({ kind: "failed", code: "artifact.not_found" });
  });

  it("shows an image artifact to the model as a file", async () => {
    let artifactId = "";
    const seen: Seen[] = [];
    brain = (result) => {
      if (!result) return { name: "files__screenshot", args: {} };
      seen.push(result);
      if (seen.length > 1) return undefined;
      artifactId = result.payload[1].artifactId;
      return { name: "read_artifact", args: { artifactId } };
    };
    await run();
    expect(seen[1]!.payload).toMatchObject({ artifactId, contentType: "image/png", size: 70 });
    expect(seen[1]!.media).toEqual([
      expect.objectContaining({ type: "media", mediaType: "image/png", reference: expect.objectContaining({ artifactId }) }),
    ]);
  });
});

describe("read_artifact and the files of messages (protocol 12)", () => {
  const app = { authorization: `Bearer ${APP}` };
  async function upload(path: string, body: string, contentType: string) {
    const response = await fetch(`${runtime.url}${path}`, {
      method: "POST",
      headers: { ...app, "content-type": contentType },
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { artifact: { artifactId: string } }).artifact.artifactId;
  }
  /** Runs a turn of session `id` whose message names `files`; the model reads `read` once. */
  async function turn(id: string, files: string[], read: Record<string, unknown>) {
    const seen: Seen[] = [];
    brain = (result) => {
      if (!result) return { name: "read_artifact", args: read };
      seen.push(result);
      return undefined;
    };
    const sent = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
      method: "POST",
      headers: { ...app, "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        requestId: id,
        idempotencyKey: id,
        parts: [{ type: "text", text: "go" }, ...files.map((artifactId) => ({ type: "file", artifactId }))],
      }),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    for (let attempt = 0; attempt < 400 && seen.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return seen[0]!;
  }

  it("reads a Tenant-wide artifact the session's messages named, at a version", async () => {
    const notes = await upload("/v1/artifacts?name=notes.txt", "first", "text/plain");
    await upload(`/v1/artifacts/${notes}/versions`, "second", "text/plain");
    await client.createSession({ id: "named-1", agentId: "plain", ownerUserId: "u:ada" });
    expect((await turn("named-1", [notes], { artifactId: notes, version: 1 })).payload).toMatchObject({
      artifactId: notes,
      version: 1,
      content: "first",
    });
    // A session whose messages did not name it does not reach it.
    await client.createSession({ id: "named-2", agentId: "plain", ownerUserId: "u:ada" });
    expect((await turn("named-2", [], { artifactId: notes })).payload).toMatchObject({
      kind: "failed",
      code: "artifact.not_found",
    });
  });

  it("refuses a file of a type the turn's model does not read (protocol 15)", async () => {
    await client.createSession({ id: "named-3", agentId: "plain", ownerUserId: "u:ada" });
    const pdf = await upload("/v1/artifacts?name=own.pdf&sessionId=named-3", "%PDF-1.4", "application/pdf");
    // Our engine decides by the model descriptor: none here, so text and images only.
    expect((await turn("named-3", [], { artifactId: pdf })).payload).toEqual({
      kind: "failed",
      code: "artifact.unsupported",
      message: "own.pdf is application/pdf: this model does not read PDFs.",
    });
  });

  it("inlines a text file a message names into the turn's call (protocol 15)", async () => {
    const notes = await upload("/v1/artifacts?name=brief.md", "# Brief", "text/markdown");
    await client.createSession({ id: "named-4", agentId: "plain", ownerUserId: "u:ada" });
    // The model reads it once more with read_artifact; the turn's calls carry it inlined.
    expect((await turn("named-4", [notes], { artifactId: notes })).payload).toMatchObject({ content: "# Brief" });
    expect(JSON.stringify(filesMessage(lastPrompt!))).toContain(
      JSON.stringify('<file name="brief.md" type="text/markdown">\n# Brief\n</file>').slice(1, -1),
    );
  });
});

describe("when the artifact cannot be stored", () => {
  it("keeps the preview, says the rest was dropped, and stays under the cap", async () => {
    const limits = (body: unknown) =>
      fetch(`${runtime.url}/v1/tenant/artifacts`, {
        method: "PUT",
        headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await limits({ limits: { fileBytes: 64 * KiB } })).status).toBe(200);
    try {
      const seen = once("files__big_text");
      const result = await run();
      expect(seen[0]!.status).toBe("completed");
      expect(seen[0]!.payload).toEqual({
        truncated: true,
        dropped: expect.stringContaining("could not be stored as an artifact"),
        size: Buffer.byteLength(BIG),
        preview: expect.any(String),
      });
      expect(result.created).toEqual([]);
      expect(Buffer.byteLength(JSON.stringify(seen[0]!.payload))).toBeLessThan(32 * KiB);
      expect(largest(result.recorded)).toBeLessThan(EVENT_MAX);
    } finally {
      expect((await limits({})).status).toBe(200);
    }
  });
});

describe("one step's results share a budget", () => {
  it("keeps forty parallel 30 KiB results of one step in one event well under S2's 1 MiB", async () => {
    const N = 40;
    brain = (result) =>
      result ? undefined : Array.from({ length: N }, (_, n) => ({ name: "files__chunk", args: { n } }));
    const result = await run();
    expect(result.status).toBe("completed");
    expect(results).toHaveLength(N);

    // The step's results took at most the budget, and a stub each past it.
    const sizes = results.map((seen) => Buffer.byteLength(JSON.stringify(seen.payload)));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(256 * KiB + N * 512);
    const inline = results.filter((seen) => typeof seen.payload === "string");
    const stored = results.filter((seen) => seen.payload?.truncated === true);
    expect(inline.length + stored.length).toBe(N);
    expect(inline.length).toBeGreaterThan(0);
    expect(stored.length).toBeGreaterThan(N / 2);
    for (const seen of stored) expect(seen.payload.artifactId).toMatch(/^af_/);
    // A stub's artifact holds the whole result.
    const last = stored.at(-1)!.payload;
    const n = Number(/^chunk (\d+)/u.exec(await download(last.artifactId).then(String))![1]);
    expect((await download(last.artifactId)).toString("utf8")).toBe(chunk(n));

    // No entry near 1 MiB; only the entry holding the step's results passes 64 KiB, and every
    // event fits the record entry limit (a transcript edit fills events up to it, B15).
    const entries = result.recorded.flatMap((event) =>
      event.type === "transcript.updated" ? (event.payload as { entries: unknown[] }).entries : [event],
    );
    const sized = entries.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
    for (const bytes of sized) expect(bytes).toBeLessThan(320 * KiB);
    expect(sized.filter((bytes) => bytes >= EVENT_MAX).length).toBeLessThanOrEqual(1);
    for (const event of result.recorded)
      expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThanOrEqual(RUNTIME_LIMIT_DEFAULTS.recordEntryBytes);
  });
});

describe("the session view", () => {
  it("names the definition a session was opened from beside its pinned manifest's hash", async () => {
    const session = await client.createSession({ id: "results-view", agentId: "reader", ownerUserId: "u:ada" });
    const view = (await session.inspect()) as { manifestHash: string; definitionHash?: string };
    const definitions = await client.listAgents();
    const registered = definitions.agents.find((agent) => agent.agentId === "reader")!;
    // Without a sandbox or skills, nothing is pinned beside the definition (protocol 15).
    expect(view.definitionHash).toBe(registered.manifestHash);
    expect(view.manifestHash).toBe(registered.manifestHash);
  });
});

