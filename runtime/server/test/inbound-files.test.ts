/**
 * Inbound files against the accept check (multimodal messages, M2 and M7): with a model in the
 * vault that reads images and not PDFs, a PDF sent inline over AG-UI or A2A is refused like any
 * other message's file, and the artifact stored for it is deleted. The A2A card names the files
 * that model reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextSessionId } from "../src/api/a2a/tasks.js";
import { sessionIdFor } from "../src/api/ag-ui/session-id.js";
import { APP, startSubjectTenant, type SubjectTenant } from "./security/subjects.js";

let tenant: SubjectTenant;

const PDF = Buffer.from("%PDF-1.4 a brief").toString("base64");
const asSubject = (subject: string) => ({
  authorization: `Bearer ${APP}`,
  "nylorun-subject": subject,
  "nylorun-scopes": "sessions:own",
});

/** The artifacts of a session, as the application sees them. */
async function artifactsOf(sessionId: string): Promise<unknown[]> {
  const listed = await tenant.call("GET", `/v1/artifacts?sessionId=${encodeURIComponent(sessionId)}`);
  expect(listed.status, listed.text).toBe(200);
  return listed.body.artifacts;
}

beforeAll(async () => {
  tenant = await startSubjectTenant();
  // A model that reads images, not PDFs: the accept check runs against it.
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
  await tenant?.close();
});

describe("a file the model does not read", () => {
  it("is a RUN_ERROR attachment_unsupported over AG-UI, and its artifact is deleted", async () => {
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
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "attachment_unsupported",
      message: expect.any(String),
    });
    expect(events.map((event) => event.type)).not.toContain("RUN_FINISHED");
    expect(await artifactsOf(sessionIdFor("app:pia", "bot", "p1"))).toEqual([]);
  });

  it("is ContentTypeNotSupportedError over A2A, with its reason, and its artifact is deleted", async () => {
    const rpc = async (message: Record<string, unknown>) => {
      const response = await fetch(`${tenant.runtime.url}/v1/a2a/agents/bot`, {
        method: "POST",
        headers: { "content-type": "application/json", "A2A-Version": "1.0", ...asSubject("app:quin") },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message } }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as any;
    };
    const opened = await rpc({ messageId: "q1", role: "ROLE_USER", parts: [{ text: "Hello" }] });
    const { contextId } = opened.result.task;
    const refused = await rpc({
      messageId: "q2",
      role: "ROLE_USER",
      contextId,
      parts: [{ text: "Summarize this" }, { raw: PDF, mediaType: "application/pdf", filename: "brief.pdf" }],
    });
    expect(refused.error).toMatchObject({
      code: -32005,
      message: expect.stringContaining("PDF"),
      data: [expect.objectContaining({ reason: "CONTENT_TYPE_NOT_SUPPORTED", metadata: { reason: "attachment_unsupported" } })],
    });
    expect(await artifactsOf(contextSessionId("app:quin", "bot", contextId))).toEqual([]);
  });
});

describe("the A2A card", () => {
  it("advertises the media types the Tenant's model reads", async () => {
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
