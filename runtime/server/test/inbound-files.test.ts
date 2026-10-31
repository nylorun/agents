/**
 * Inbound files (multimodal messages, M2 and M7; protocol 15): with a model in the vault that
 * reads images and not PDFs, a PDF sent inline over AG-UI or A2A is accepted like any other
 * message's file, and the turn runs: the harness tells the model why it does not see it. A
 * message the Runtime refuses still takes the files stored for it. The A2A card names the files
 * that model reads natively.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelCall } from "@nylorun/core/define";
import { contextSessionId } from "../src/api/a2a/tasks.js";
import { sessionIdFor } from "../src/api/ag-ui/session-id.js";
import { APP, startSubjectTenant, type SubjectTenant } from "./security/subjects.js";

let tenant: SubjectTenant;

const PDF = Buffer.from("%PDF-1.4 a brief").toString("base64");
const NOTE = '(File "brief.pdf", application/pdf, is not shown: this model does not read PDFs.)';
const asSubject = (subject: string) => ({
  authorization: `Bearer ${APP}`,
  "nylorun-subject": subject,
  "nylorun-scopes": "sessions:own",
});

/** The model's calls; one whose last message says "hold" waits for `release`. */
const calls: ModelCall[] = [];
let release: () => void = () => {};
const held = new Promise<void>((resolve) => (release = resolve));
const textOf = (call: ModelCall) => JSON.stringify(call.prompt);

/** The artifacts of a session, as the application sees them. */
async function artifactsOf(sessionId: string): Promise<unknown[]> {
  const listed = await tenant.call("GET", `/v1/artifacts?sessionId=${encodeURIComponent(sessionId)}`);
  expect(listed.status, listed.text).toBe(200);
  return listed.body.artifacts;
}

beforeAll(async () => {
  tenant = await startSubjectTenant({
    modelProvider: async (effect) => {
      const call = effect.input as ModelCall;
      calls.push(call);
      if (textOf(call).includes('"hold"')) await held;
      return { output: [{ type: "text", text: "ok" }] };
    },
  });
  // A model that reads images, not PDFs: the harness decides by its descriptor.
  const configured = await fetch(`${tenant.runtime.url}/v1/tenant/model`, {
    method: "PUT",
    headers: { ...tenant.runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "model-1",
      idempotencyKey: "model-1",
      provider: "custom",
      model: "vision-model",
      baseUrl: "https://provider.invalid/v1",
      settings: { inputs: ["image"] },
      auth: { type: "api_key", key: "inbound-files-provider-key" },
    }),
  });
  expect(configured.status, await configured.clone().text()).toBe(200);
});
afterAll(async () => {
  release();
  await tenant?.close();
});

const a2a = async (subject: string, message: Record<string, unknown>, configuration?: Record<string, unknown>) => {
  const response = await fetch(`${tenant.runtime.url}/v1/a2a/agents/bot`, {
    method: "POST",
    headers: { "content-type": "application/json", "A2A-Version": "1.0", ...asSubject(subject) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message, ...(configuration ? { configuration } : {}) },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as any;
};

describe("a file the model does not read", () => {
  it("is accepted over AG-UI, and the model is told why it does not see it", async () => {
    const response = await fetch(`${tenant.runtime.url}/v1/ag-ui/agents/bot`, {
      method: "POST",
      headers: { "content-type": "application/json", ...asSubject("app:pia") },
      body: JSON.stringify({
        threadId: "p1",
        runId: "run-1",
        messages: [
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "Summarize this" },
              {
                type: "document",
                source: { type: "data", value: PDF, mimeType: "application/pdf" },
                metadata: { filename: "brief.pdf" },
              },
            ],
          },
        ],
        tools: [],
        context: [],
      }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n\n")
      .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(await artifactsOf(sessionIdFor("app:pia", "bot", "p1"))).toHaveLength(1);
    expect(textOf(calls.at(-1)!)).toContain(JSON.stringify(NOTE).slice(1, -1));
  });

  it("is accepted over A2A, and the task completes", async () => {
    const opened = await a2a("app:quin", { messageId: "q1", role: "ROLE_USER", parts: [{ text: "Hello" }] });
    const { contextId } = opened.result.task;
    const sent = await a2a("app:quin", {
      messageId: "q2",
      role: "ROLE_USER",
      contextId,
      parts: [{ text: "Summarize this" }, { raw: PDF, mediaType: "application/pdf", filename: "brief.pdf" }],
    });
    expect(sent.error).toBeUndefined();
    expect(sent.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(await artifactsOf(contextSessionId("app:quin", "bot", contextId))).toHaveLength(1);
    expect(textOf(calls.at(-1)!)).toContain(JSON.stringify(NOTE).slice(1, -1));
  });
});

describe("a message the Runtime refuses", () => {
  it("leaves no files behind: a busy context over A2A", async () => {
    const opened = await a2a(
      "app:rae",
      { messageId: "r1", role: "ROLE_USER", parts: [{ text: "hold" }] },
      { returnImmediately: true },
    );
    const { contextId } = opened.result.task;
    const refused = await a2a("app:rae", {
      messageId: "r2",
      role: "ROLE_USER",
      contextId,
      parts: [{ text: "Summarize this" }, { raw: PDF, mediaType: "application/pdf", filename: "brief.pdf" }],
      // A follow-up is queued (profile v2) unless the caller asks for the refusal.
      metadata: { delivery: "reject" },
    });
    expect(refused.error).toMatchObject({ code: -32004 });
    expect(refused.error.data[0].reason).toBe("CONTEXT_BUSY");
    expect(await artifactsOf(contextSessionId("app:rae", "bot", contextId))).toEqual([]);
    release();
  });
});

describe("the A2A card", () => {
  it("advertises the media types the Tenant's model reads natively", async () => {
    const response = await fetch(`${tenant.runtime.url}/v1/a2a/agents/bot/card`, {
      headers: { authorization: `Bearer ${APP}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).defaultInputModes).toEqual([
      "text/plain",
      "application/json",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  });
});
