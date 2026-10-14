/**
 * Native file blocks (M4): a marker text part pi-ai carries through untouched, rewritten in the
 * provider payload into each API's own block. The fixtures are payloads pi-ai built for a user
 * message `["Files for this turn:", <marker>, "after"]` (recorded from `onPayload`), and the last
 * test has pi-ai build them again and checks the body each provider would receive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_FILE_KINDS,
  NativeBlocks,
  nativeKindsOf,
  type NativeFile,
} from "../src/model/native-blocks.js";

const PDF: NativeFile = { kind: "pdf", mediaType: "application/pdf", name: "report.pdf", data: "JVBERi0=" };
const DOCX: NativeFile = {
  kind: "office",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  name: "notes.docx",
  data: "UEsDBA==",
};
const WAV: NativeFile = { kind: "audio", mediaType: "audio/wav", name: "hello.wav", data: "UklGRg==" };
const MP3: NativeFile = { kind: "audio", mediaType: "audio/mpeg", name: "hello.mp3", data: "SUQz" };
const OGG: NativeFile = { kind: "audio", mediaType: "audio/ogg", name: "hello.ogg", data: "T2dnUw==" };
const MP4: NativeFile = { kind: "video", mediaType: "video/mp4", name: "clip.mp4", data: "AAAAIGZ0eXA=" };

/** Recorded payloads, by API, for one user message with the marker between two texts. */
const RECORDED: Record<string, (marker: string, cache?: boolean) => any> = {
  "anthropic-messages": (marker, cache) => ({
    model: "m",
    messages: [
      { role: "user", content: "earlier" },
      {
        role: "user",
        content: [
          { type: "text", text: "Files for this turn:" },
          { type: "text", text: marker, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) },
          ...(cache ? [] : [{ type: "text", text: "after", cache_control: { type: "ephemeral" } }]),
        ],
      },
    ],
    max_tokens: 1000,
    stream: true,
  }),
  "openai-responses": (marker) => ({
    model: "m",
    input: [
      { role: "user", content: [{ type: "input_text", text: "earlier" }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Files for this turn:" },
          { type: "input_text", text: marker },
          { type: "input_text", text: "after" },
        ],
      },
    ],
    stream: true,
    prompt_cache_key: "s",
    store: false,
    max_output_tokens: 1000,
  }),
  "openai-completions": (marker, cache) => ({
    model: "m",
    messages: [
      { role: "user", content: "earlier" },
      {
        role: "user",
        content: [
          { type: "text", text: "Files for this turn:" },
          { type: "text", text: marker, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) },
          ...(cache ? [] : [{ type: "text", text: "after" }]),
        ],
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: 1000,
  }),
  "google-generative-ai": (marker) => ({
    model: "m",
    contents: [
      { role: "user", parts: [{ text: "earlier" }] },
      { role: "user", parts: [{ text: "Files for this turn:" }, { text: marker }, { text: "after" }] },
    ],
    config: { maxOutputTokens: 1000 },
  }),
};
RECORDED["azure-openai-responses"] = RECORDED["openai-responses"]!;
RECORDED["google-vertex"] = RECORDED["google-generative-ai"]!;

/** The user message's parts in a payload, wherever the API keeps them. */
function lastParts(payload: any): any[] {
  const items = payload.messages ?? payload.input ?? payload.contents;
  const last = items.at(-1);
  return last.content ?? last.parts;
}

function rewritten(api: string, file: NativeFile, cache?: boolean) {
  const natives = new NativeBlocks();
  const marker = natives.add(file).text;
  const payload = natives.rewrite(RECORDED[api]!(marker, cache), api);
  return { natives, payload, parts: lastParts(payload) };
}

describe("NativeBlocks", () => {
  it("adds a unique marker text part per file", () => {
    const natives = new NativeBlocks();
    const a = natives.add(PDF);
    const b = natives.add(PDF);
    expect(a).toMatchObject({ type: "text" });
    expect(a.text).toMatch(/^\[\[nylorun-file:[0-9a-f-]{36}\]\]$/);
    expect(a.text).not.toBe(b.text);
    expect(natives.size).toBe(2);
  });

  it("leaves a payload alone when the call carries no file", () => {
    const natives = new NativeBlocks();
    const payload = RECORDED["anthropic-messages"]!("plain text");
    expect(natives.rewrite(payload, "bedrock-converse-stream")).toBe(payload);
    expect(natives.error).toBeUndefined();
  });

  it("anthropic-messages: a PDF becomes a document block", () => {
    const { natives, parts } = rewritten("anthropic-messages", PDF);
    expect(natives.error).toBeUndefined();
    expect(parts).toEqual([
      { type: "text", text: "Files for this turn:" },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: PDF.data },
        title: "report.pdf",
      },
      { type: "text", text: "after", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("anthropic-messages: the last block keeps its cache_control", () => {
    const { natives, parts } = rewritten("anthropic-messages", PDF, true);
    expect(natives.error).toBeUndefined();
    expect(parts.at(-1)).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: PDF.data },
      title: "report.pdf",
      cache_control: { type: "ephemeral" },
    });
  });

  it.each(["openai-responses", "azure-openai-responses"])("%s: a PDF and an office file become input_file blocks", (api) => {
    for (const file of [PDF, DOCX]) {
      const { natives, parts } = rewritten(api, file);
      expect(natives.error).toBeUndefined();
      expect(parts[1]).toEqual({
        type: "input_file",
        filename: file.name,
        file_data: `data:${file.mediaType};base64,${file.data}`,
      });
      expect(parts[2]).toEqual({ type: "input_text", text: "after" });
    }
  });

  it("openai-completions: PDF, WAV, MP3 and video blocks, cache_control kept", () => {
    expect(rewritten("openai-completions", PDF).parts[1]).toEqual({
      type: "file",
      file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${PDF.data}` },
    });
    expect(rewritten("openai-completions", WAV).parts[1]).toEqual({
      type: "input_audio",
      input_audio: { data: WAV.data, format: "wav" },
    });
    expect(rewritten("openai-completions", MP3, true).parts.at(-1)).toEqual({
      type: "input_audio",
      input_audio: { data: MP3.data, format: "mp3" },
      cache_control: { type: "ephemeral" },
    });
    expect(rewritten("openai-completions", MP4).parts[1]).toEqual({
      type: "video_url",
      video_url: { url: `data:video/mp4;base64,${MP4.data}` },
    });
  });

  it("openai-completions: audio other than WAV or MP3 is an error", () => {
    const { natives } = rewritten("openai-completions", OGG);
    expect(natives.error).toMatch(/hello\.ogg.*WAV and MP3/);
  });

  it.each(["google-generative-ai", "google-vertex"])("%s: PDF, audio and video become inlineData", (api) => {
    for (const file of [PDF, OGG, MP4]) {
      const { natives, parts } = rewritten(api, file);
      expect(natives.error).toBeUndefined();
      expect(parts).toEqual([
        { text: "Files for this turn:" },
        { inlineData: { mimeType: file.mediaType, data: file.data } },
        { text: "after" },
      ]);
    }
  });

  it("refuses a kind the API has no block for", () => {
    expect(rewritten("anthropic-messages", DOCX).natives.error).toMatch(
      /notes\.docx.*anthropic-messages: this API has no block for office files/,
    );
    expect(rewritten("google-vertex", DOCX).natives.error).toMatch(/office/);
    expect(rewritten("openai-responses", MP4).natives.error).toMatch(/video/);
  });

  it("refuses an API without a rewriter", () => {
    const natives = new NativeBlocks();
    const marker = natives.add(PDF).text;
    natives.rewrite({ messages: [{ role: "user", content: [{ text: marker }] }] }, "bedrock-converse-stream");
    expect(natives.error).toMatch(/bedrock-converse-stream/);
  });

  it("reports a marker left in the payload, or one that never arrived", () => {
    const folded = new NativeBlocks();
    const marker = folded.add(PDF).text;
    folded.rewrite(
      { model: "m", messages: [{ role: "tool", content: `result\n${marker}`, tool_call_id: "c" }] },
      "openai-completions",
    );
    expect(folded.error).toMatch(/report\.pdf/);
    const dropped = new NativeBlocks();
    dropped.add(PDF);
    dropped.rewrite(RECORDED["openai-completions"]!("no marker"), "openai-completions");
    expect(dropped.error).toMatch(/did not reach/);
  });

  it("can rewrite again: each attempt's payload, error set afresh", () => {
    const natives = new NativeBlocks();
    const marker = natives.add(PDF).text;
    natives.rewrite({ messages: [] }, "anthropic-messages");
    expect(natives.error).toBeDefined();
    natives.rewrite(RECORDED["anthropic-messages"]!(marker), "anthropic-messages");
    expect(natives.error).toBeUndefined();
  });

  it("lists the kinds each API carries", () => {
    expect(nativeKindsOf("anthropic-messages")).toEqual(["pdf"]);
    expect(nativeKindsOf("azure-openai-responses")).toEqual(["pdf", "office"]);
    expect(nativeKindsOf("google-vertex")).toEqual(["pdf", "audio", "video"]);
    expect(nativeKindsOf("bedrock-converse-stream")).toEqual([]);
    expect(nativeKindsOf("constructor")).toEqual([]);
    expect(Object.keys(NATIVE_FILE_KINDS).sort()).toEqual(Object.keys(RECORDED).sort());
  });
});

describe("through pi-ai", () => {
  afterEach(() => vi.unstubAllGlobals());

  const PROVIDERS: Record<string, { file: NativeFile; native: (body: any) => unknown }> = {
    "anthropic-messages": { file: PDF, native: (body) => lastParts(body)[1].type },
    "openai-responses": { file: DOCX, native: (body) => lastParts(body)[1].type },
    "azure-openai-responses": { file: PDF, native: (body) => lastParts(body)[1].type },
    "openai-completions": { file: WAV, native: (body) => lastParts(body)[1].type },
    "google-generative-ai": { file: MP4, native: (body) => Object.keys(lastParts(body)[1])[0] },
    "google-vertex": { file: PDF, native: (body) => Object.keys(lastParts(body)[1])[0] },
  };
  const EXPECTED: Record<string, string> = {
    "anthropic-messages": "document",
    "openai-responses": "input_file",
    "azure-openai-responses": "input_file",
    "openai-completions": "input_audio",
    "google-generative-ai": "inlineData",
    "google-vertex": "inlineData",
  };

  it.each(Object.keys(PROVIDERS))("%s: the provider receives the native block", async (api) => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "stop here" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const { streamSimple } = await import(`@earendil-works/pi-ai/api/${api}`);
    const provider: Record<string, string> = {
      "anthropic-messages": "anthropic",
      "openai-responses": "openai",
      "azure-openai-responses": "azure-openai-responses",
      "openai-completions": "openai",
      "google-generative-ai": "google",
      "google-vertex": "google-vertex",
    };
    const model = {
      id: "m",
      name: "m",
      api,
      provider: provider[api],
      baseUrl: api === "azure-openai-responses" ? "https://x.openai.azure.com/openai/v1" : "https://provider.invalid/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1_000,
    };
    const natives = new NativeBlocks();
    const marker = natives.add(PROVIDERS[api]!.file);
    const result = await streamSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Files for this turn:" }, marker, { type: "text", text: "after" }],
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: "k",
        project: "p",
        location: "us-central1",
        onPayload: (payload: unknown) => natives.rewrite(payload, api),
      },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(natives.error).toBeUndefined();
    expect(bodies).not.toHaveLength(0);
    const body = bodies.at(-1);
    expect(PROVIDERS[api]!.native(body)).toBe(EXPECTED[api]);
    expect(JSON.stringify(body)).not.toContain("nylorun-file");
  });
});
