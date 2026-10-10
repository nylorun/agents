import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactHref,
  artifactReferences,
  previewBytes,
  previewKind,
} from "../web/src/resources/artifacts.ts";

test("HTML and SVG render as escaped source, raster images alone use image preview", () => {
  for (const type of [
    "text/html",
    "image/svg+xml",
    "application/json; charset=utf-8",
    "text/plain",
  ])
    assert.equal(previewKind(type), "text", type);
  assert.equal(previewKind("IMAGE/PNG"), "image");
  assert.equal(previewKind("application/pdf"), "download");
});

test("preview reads stop at the cap even when Range is ignored, and cancel the response", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(100).fill(65));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await previewBytes(
    new Response(stream),
    256,
    new AbortController().signal,
  );
  assert.equal(result.bytes.length, 256);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
  const exact = await previewBytes(
    new Response("abc"),
    3,
    new AbortController().signal,
  );
  assert.equal(new TextDecoder().decode(exact.bytes), "abc");
  assert.equal(exact.truncated, false);
});

test("selection cancellation unblocks a held preview read", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const result = previewBytes(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
    20,
    abort.signal,
  );
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("artifact links preserve explicit versions and round-trip ids; no guessed latest version", () => {
  const event = {
    type: "command.message",
    payload: {
      parts: [
        { type: "file", artifactId: "a/b", version: 2 },
        { type: "file", artifactId: "unversioned" },
        { type: "file", artifactId: "invalid", version: 0 },
      ],
    },
  };
  assert.deepEqual(artifactReferences(event), [
    { artifactId: "a/b", version: 2, name: "a/b" },
  ]);
  const created = {
    type: "artifact.version.created",
    payload: { artifactId: "a", version: 1, name: "Report" },
  };
  assert.deepEqual(artifactReferences(created), [
    { artifactId: "a", version: 1, name: "Report" },
  ]);
  const url = new URL(artifactHref("a/b", 2, "s +1"), "https://studio.example");
  assert.equal(url.searchParams.get("selected"), "a/b");
  assert.equal(url.searchParams.get("sessionId"), "s +1");
  assert.equal(url.searchParams.get("version"), "2");
});
