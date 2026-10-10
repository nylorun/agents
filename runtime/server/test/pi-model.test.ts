import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piModel } from "../src/model/pi-model.js";
import type { RuntimeModelCall } from "../src/contracts.js";
import { scrub } from "../src/redact.js";
const roots: string[] = [];
const selection = {
  provider: "custom",
  model: "test-model",
  custom: { baseUrl: "https://provider.invalid/v1" },
};
const host = (
  input: {
    provider?: string;
    model?: string;
    key?: string;
    baseUrl?: string;
  } = {},
) => {
  const provider = input.provider ?? selection.provider;
  return {
    readHostModel: () => ({
      provider,
      model: input.model ?? selection.model,
      ...(provider === "custom"
        ? { baseUrl: input.baseUrl ?? selection.custom.baseUrl }
        : {}),
      authType: "api_key" as const,
      credential: {
        type: "api_key" as const,
        key: input.key ?? "test-provider-secret",
      },
    }),
  };
};
const signal = () => new AbortController().signal;
const call: RuntimeModelCall = {
  sessionId: "test",
  tools: [],
  prompt: [
    {
      kind: "message",
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function response(delta: unknown, finishReason = "stop") {
  return new Response(
    `data: ${JSON.stringify({
      id: "test",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({
      id: "test",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
it("calls the provider with the host vault key and ignores the environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-environment-"));
  roots.push(root);
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "environment-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      expect(new Headers(options.headers).get("authorization")).toBe(
        "Bearer vault-key",
      );
      return response({ role: "assistant", content: "environment response" });
    }),
  );
  const result = await piModel({ root, ...host({ key: "vault-key" }) })(call, {
    signal: signal(),
  });
  expect(result.output).toEqual([
    { type: "text", text: "environment response" },
  ]);
  expect(await readdir(root)).toEqual([]);
});
it("loads configuration lazily and reports missing setup only on invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lazy-"));
  roots.push(root);
  const adapter = piModel({ root });
  // A missing provider is a known failure, not a lost call: the turn fails with model.auth.
  await expect(adapter(call, { signal: signal() })).resolves.toMatchObject({
    kind: "failed",
    code: "auth",
    retryable: false,
    message: expect.stringContaining("Model provider is not configured"),
  });
});
it("preserves context, assistant tool calls, tool results and model controls through the provider", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-provider-secret");
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      body = JSON.parse(options.body);
      return response({ role: "assistant", content: "42" });
    }),
  );
  const adapter = piModel(host());
  const result = await adapter(
    {
      ...call,
      model: { controls: { temperature: 0.2, maxOutputTokens: 80 } },
      tools: [
        {
          name: "calculate",
          description: "Calculate",
          inputSchema: { type: "object" },
        },
      ],
      prompt: [
        {
          kind: "instructions",
          role: "system",
          content: [{ type: "text", text: "Be brief." }],
        },
        {
          kind: "context",
          role: "user",
          content: [{ type: "text", text: "context facts" }],
        },
        {
          kind: "message",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              id: "call-1",
              name: "calculate",
              args: { value: 42 },
            },
          ],
        },
        {
          kind: "tool-result",
          toolCallId: "call-1",
          toolName: "calculate",
          status: "completed",
          content: [{ type: "text", text: "42" }],
        },
      ],
    },
    { signal: signal() },
  );
  expect(result.output).toEqual([{ type: "text", text: "42" }]);
  expect(JSON.stringify(body.messages)).toContain("context facts");
  expect(JSON.stringify(body.messages)).toContain('"tool_call_id":"call-1"');
  expect(JSON.stringify(body.messages)).toContain('"tool_calls"');
  expect(body.temperature).toBe(0.2);
  expect(body.max_tokens ?? body.max_completion_tokens).toBe(80);
});
describe("an image a tool returned (R2b C11, Q23)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const reference = { artifactId: "af_screenshot", version: 1, name: "files__screenshot-result-2.png" };
  const screenshot: RuntimeModelCall = {
    ...call,
    prompt: [
      ...call.prompt,
      {
        kind: "message",
        role: "assistant",
        content: [{ type: "tool-call", id: "call-1", name: "files__screenshot", args: {} }],
      },
      {
        kind: "tool-result",
        toolCallId: "call-1",
        toolName: "files__screenshot",
        status: "completed",
        content: [
          { type: "text", text: '[{"type":"image","artifactId":"af_screenshot"}]' },
          { type: "media", mediaType: "image/png", reference },
        ],
      },
    ],
  };
  /** The provider's request body, and the references the model call read. */
  async function send(model: { provider?: string; model?: string }) {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        body = String(options.body);
        return response({ role: "assistant", content: "seen" });
      }),
    );
    const read: unknown[] = [];
    const files = async (value: unknown) => {
      read.push(value);
      return { name: reference.name, mediaType: "image/png", bytes: PNG };
    };
    const result = await piModel({ ...host(model), files })(screenshot, { signal: signal() });
    return { result, body, read };
  }

  it("shows it to a model that reads images", async () => {
    const { result, body, read } = await send({});
    expect(result.output).toEqual([{ type: "text", text: "seen" }]);
    expect(read).toEqual([reference]);
    expect(body).toContain(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("gives a model that reads no images a note, and reads no bytes", async () => {
    const { result, body, read } = await send({ provider: "groq", model: "llama-3.1-8b-instant" });
    expect(result.output).toEqual([{ type: "text", text: "seen" }]);
    expect(read).toEqual([]);
    expect(body).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(body).toContain("The tool returned an image, image/png, that is not shown: this model does not accept images.");
  });
});
it("returns provider tool calls using the portable model contract", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-provider-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "tool-1",
              type: "function",
              function: { name: "calculate", arguments: '{"value":42}' },
            },
          ],
        },
        "tool_calls",
      ),
    ),
  );
  expect(
    await piModel(host())(call, { signal: signal() }),
  ).toMatchObject({
    finishReason: "tool-calls",
    output: [
      {
        type: "tool-call",
        id: "tool-1",
        name: "calculate",
        args: { value: 42 },
      },
    ],
  });
});
it("honors cancellation before contacting a provider", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(
    piModel(host())(call, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("redacts credentials read from the vault in provider failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vault-"));
  roots.push(root);
  await mkdir(join(root, ".env"));
  await writeFile(
    join(root, ".env", "auth.json"),
    JSON.stringify({ custom: { type: "api_key", key: "vault-test-secret" } }),
  );
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "vault-test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "denied vault-test-secret" } }),
          { status: 401 },
        ),
    ),
  );
  const outcome = await piModel({ root, ...host({ key: "vault-test-secret" }) })(
    call,
    { signal: signal() },
  );
  expect(outcome).toMatchObject({ kind: "failed", code: "auth" });
  expect(JSON.stringify(outcome)).toContain("[redacted]");
  expect(JSON.stringify(outcome)).not.toContain("vault-test-secret");
});
it("keeps usage counters while redacting credential fields and inline images", () => {
  expect(
    scrub(
      {
        inputTokens: 10,
        access_token: "secret",
        api_key: "secret",
        preview: "data:image/png;base64,abcd",
      },
      [],
    ),
  ).toEqual({
    inputTokens: 10,
    access_token: "[redacted]",
    api_key: "[redacted]",
    preview: "[inline image data redacted]",
  });
});
it.each(["tool", "text", "reasoning"])(
  "replays Gemini %s signatures on the tool-result request",
  async (signatureBlock) => {
    vi.stubEnv("GEMINI_API_KEY", "test-google-secret");
    const requests: { contents: { role: string; parts: unknown[] }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        const body =
          options?.body ??
          (url instanceof Request ? await url.text() : undefined);
        requests.push(JSON.parse(String(body)));
        const parts =
          requests.length === 1
            ? [
                ...(signatureBlock === "text"
                  ? [{ text: "", thoughtSignature: "dGV4dA==" }]
                  : []),
                ...(signatureBlock === "reasoning"
                  ? [
                      {
                        text: "",
                        thought: true,
                        thoughtSignature: "dGhpbmtpbmc=",
                      },
                    ]
                  : []),
                {
                  functionCall: { name: "add_numbers", args: { a: 19, b: 7 } },
                  thoughtSignature: "c2lnbmF0dXJl",
                },
              ]
            : [{ text: "26" }];
        return new Response(
          `data: ${JSON.stringify({
            candidates: [
              { content: { role: "model", parts }, finishReason: "STOP" },
            ],
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const adapter = piModel(
      host({
        provider: "google",
        model: "gemini-flash-latest",
        key: "test-google-secret",
      }),
    );
    const first = await adapter(call, { signal: signal() });
    const toolCall = first.output.find((part) => part.type === "tool-call");
    if (!toolCall || toolCall.type !== "tool-call")
      throw new Error("Missing function call");
    const nextCall: RuntimeModelCall = {
      ...call,
      prompt: [
        ...call.prompt,
        {
          kind: "message",
          role: "assistant",
          content: first.output.filter((part) => part.type !== "json"),
        },
        {
          kind: "tool-result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          status: "completed",
          content: [{ type: "text", text: '{"sum":26}' }],
        },
      ],
    };
    // A fresh adapter and JSON round trip rule out hidden per-instance state.
    await piModel(
      host({
        provider: "google",
        model: "gemini-flash-latest",
        key: "test-google-secret",
      }),
    )(JSON.parse(JSON.stringify(nextCall)), { signal: signal() });
    expect(
      requests[1]?.contents.find((message) => message.role === "model")?.parts,
    ).toContainEqual({
      functionCall: { name: "add_numbers", args: { a: 19, b: 7 } },
      thoughtSignature: "c2lnbmF0dXJl",
    });
    if (signatureBlock === "text")
      expect(
        requests[1]?.contents.find((message) => message.role === "model")
          ?.parts[0],
      ).toEqual({ text: "", thoughtSignature: "dGV4dA==" });
    if (signatureBlock === "reasoning")
      expect(
        requests[1]?.contents.find((message) => message.role === "model")
          ?.parts[0],
      ).toEqual({ text: "", thought: true, thoughtSignature: "dGhpbmtpbmc=" });
    await piModel(
      host({
        provider: "google",
        model: "gemini-2.5-flash",
        key: "test-google-secret",
      }),
    )(nextCall, { signal: signal() });
    expect(JSON.stringify(requests[2])).not.toContain("thoughtSignature");
  },
);

it("sends the session id as OpenAI's prompt cache key", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response("{}", { status: 500 });
    }),
  );
  await piModel({
    ...host({ provider: "openai", model: "gpt-4.1-mini" }),
    settings: { attempts: 1 },
  })({ ...call, executionId: "session-123" }, { signal: signal() });
  expect(body.prompt_cache_key).toBe("session-123");
});

it("streams one code path and maps every usage counter", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(
        `data: ${JSON.stringify({
          id: "test",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        })}\n\ndata: ${JSON.stringify({
          id: "test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 60 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const result = await piModel(host())(
    { ...call, executionId: "session-123" },
    { signal: signal() },
  );
  expect(body.stream).toBe(true);
  expect(result).toMatchObject({
    usage: { outputTokens: 20, cachedTokens: 60, reasoningTokens: 5 },
    evidence: {
      extras: {
        producer: { provider: "custom", api: "openai-completions", model: "test-model" },
      },
    },
  });
});

it("repairs a structured final answer instead of failing the call", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({ role: "assistant", content: '```json\n{"answer": "line one\nline two"}\n```' }),
    ),
  );
  expect(
    await piModel(host())(
      { ...call, outputSchema: { type: "object" } },
      { signal: signal() },
    ),
  ).toMatchObject({ output: [{ type: "json", value: { answer: "line one\nline two" } }] });
});

it("returns invalid_output when the structured answer cannot be repaired", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ role: "assistant", content: "not json at all" })),
  );
  expect(
    await piModel(host())(
      { ...call, outputSchema: { type: "object" } },
      { signal: signal() },
    ),
  ).toMatchObject({ kind: "failed", code: "invalid_output", retryable: false });
});

it("marks OpenAI-compatible reasoning as replayed within its turn only", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({ role: "assistant", reasoning_content: "think", content: "done" }),
    ),
  );
  const result = await piModel(host())(call, { signal: signal() });
  expect(result).toMatchObject({
    output: expect.arrayContaining([
      {
        type: "reasoning",
        text: "think",
        providerMetadata: {
          replay: "turn",
          pi: { provider: "custom", model: "test-model", signature: "reasoning_content" },
        },
      },
      { type: "text", text: "done" },
    ]),
  });
});

it("replays another model's history with its own producer, without its signatures", async () => {
  let body: Record<string, any> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      body = JSON.parse(options.body);
      return response({ role: "assistant", content: "ok" });
    }),
  );
  await piModel(host())(
    {
      ...call,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      prompt: [
        ...call.prompt,
        {
          kind: "message",
          role: "assistant",
          producer: { provider: "anthropic", api: "anthropic-messages", model: "claude-x" },
          content: [
            {
              type: "reasoning",
              text: "private",
              providerMetadata: {
                pi: { provider: "anthropic", model: "claude-x", signature: "sig" },
              },
            },
            { type: "tool-call", id: "toolu_01|weird", name: "lookup", args: {} },
          ],
        },
        {
          kind: "tool-result",
          toolCallId: "toolu_01|weird",
          toolName: "lookup",
          status: "completed",
          content: [{ type: "text", text: "found" }],
        },
      ],
    },
    { signal: signal() },
  );
  const text = JSON.stringify(body.messages);
  expect(text).not.toContain('"sig"');
  expect(text).not.toContain("|weird");
  expect(text).toContain('"tool_calls"');
});

it("retries a rate-limited call and returns the answer", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      if (calls <= 2)
        return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
          status: 429,
          headers: { "retry-after-ms": "1" },
        });
      return response({ role: "assistant", content: "after retry" });
    }),
  );
  const result = await piModel({ ...host(), settings: { retryBaseDelayMs: 1 } })(call, {
    signal: signal(),
  });
  expect(result).toMatchObject({ output: [{ type: "text", text: "after retry" }] });
  expect(calls).toBe(3);
});

it.each([
  [503, "The server is overloaded", "overloaded", true],
  [401, "Incorrect API key provided", "auth", false],
  [400, "This model's maximum context length is 8192 tokens", "context_overflow", false],
] as const)(
  "classifies a %s response as %s",
  async (status, message, code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status })),
    );
    expect(
      await piModel({ ...host(), settings: { retryBaseDelayMs: 1 } })(call, {
        signal: signal(),
      }),
    ).toMatchObject({ kind: "failed", code, retryable });
  },
);

it("aborts an idle stream and reports a timeout after retrying", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      calls++;
      const requestSignal = options.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(controller) {
            requestSignal.addEventListener("abort", () =>
              controller.error(requestSignal.reason),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  expect(
    await piModel({
      ...host(),
      settings: { idleTimeoutMs: 30, retryBaseDelayMs: 1, attempts: 2 },
    })(call, { signal: signal() }),
  ).toMatchObject({ kind: "failed", code: "timeout", retryable: true });
  expect(calls).toBe(2);
});

it("rethrows a cancellation during the call instead of reporting a failure", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const requestSignal = options.signal as AbortSignal;
      queueMicrotask(() => controller.abort(new Error("cancelled")));
      return new Response(
        new ReadableStream({
          start(stream) {
            requestSignal.addEventListener("abort", () => stream.error(requestSignal.reason));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  await expect(
    piModel(host())(call, { signal: controller.signal }),
  ).rejects.toThrow();
});
