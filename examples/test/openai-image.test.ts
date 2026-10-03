import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelAdapterContext, ModelCall, ModelRequest } from "@nylorun/core/define";
import { createOpenAIImageEditor } from "../agents/interior-design/image-editor.js";
import { piModel } from "@nylorun/runtime/node";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const encodedPng = Buffer.from(png).toString("base64");

describe("OpenAI image integrations", () => {
  it("uses the supported gpt-image-2 edit request shape and validates returned PNG data", async () => {
    let body: FormData | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body as FormData;
        return new Response(
          JSON.stringify({ data: [{ b64_json: encodedPng }] }),
          { status: 200 },
        );
      }),
    );
    try {
      const editor = createOpenAIImageEditor({
        apiKey: "test-key",
        model: "gpt-image-2",
      });
      const result = await editor.edit({
        bytes: png,
        mediaType: "image/png",
        prompt: "Reimagine this room.",
        signal: new AbortController().signal,
      });
      expect(result.mediaType).toBe("image/png");
      expect([...result.bytes]).toEqual([...png]);
      expect(body?.get("model")).toBe("gpt-image-2");
      expect(body?.get("quality")).toBe("medium");
      expect(body?.get("output_format")).toBe("png");
      expect(body?.get("size")).toBe("1536x1024");
      expect(body?.has("input_fidelity")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed image data returned by the image API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ b64_json: "not-base64!" }] })),
      ),
    );
    try {
      const editor = createOpenAIImageEditor({
        apiKey: "test-key",
        model: "gpt-image-2",
      });
      await expect(
        editor.edit({
          bytes: png,
          mediaType: "image/png",
          prompt: "Reimagine this room.",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("canonical base64");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("materializes file references only in the provider wire request", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-compatible-media-test-"));
    // The Runtime resolves an artifact reference from its Object store; here, from memory.
    const asset = { id: "af_00000000000000000000000001", version: 1 };
    const files = async (reference: unknown) => {
      expect(reference).toEqual({ artifactId: asset.id, version: asset.version });
      return { name: "room.png", mediaType: "image/png", bytes: png };
    };
    let requestBody = "";
    let prepared: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body);
        return new Response(
          'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Done."},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const context = {
      request: {} as ModelRequest,
      invocationId: "invocation",
      signal: new AbortController().signal,
      reportPreparedCall(value: unknown) {
        prepared = value;
      },
    } as ModelAdapterContext;
    const call: ModelCall = {
      executionId: "room",
      prompt: [
        {
          kind: "message",
          role: "user",
          content: [
            { type: "text", text: "Redesign this room." },
            {
              type: "media",
              mediaType: "image/png",
              reference: { artifactId: asset.id, version: asset.version },
            },
          ],
        },
      ],
      tools: [],
    };
    try {
      const adapter = piModel({
        root,
        files,
        readHostModel: () => ({
          provider: "custom",
          model: "vision-test",
          baseUrl: "https://provider.example/v1",
          authType: "api_key",
          credential: { type: "api_key", key: "test-provider-key" },
        }),
      });
      await expect(adapter(call, context)).resolves.toMatchObject({
        output: [{ type: "text" }],
      });
      expect(requestBody).toContain(`data:image/png;base64,${encodedPng}`);
      expect(JSON.stringify(prepared)).toContain(asset.id);
      expect(JSON.stringify(prepared)).not.toContain(encodedPng);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
