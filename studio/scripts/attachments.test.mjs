import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_INPUTS,
  acceptFor,
  attachmentRefusal,
  formatBytes,
} from "../web/src/attachments.ts";

test("the file picker accepts what the model reads; text and images when the Runtime does not say", () => {
  assert.deepEqual(DEFAULT_MODEL_INPUTS, ["text", "image"]);
  assert.equal(acceptFor(undefined), "text/*,.md,.json,.csv,.txt,image/*");
  assert.equal(acceptFor(["text", "image", "pdf"]), "text/*,.md,.json,.csv,.txt,image/*,application/pdf");
  assert.equal(acceptFor(["office", "audio", "video"]), ".docx,.xlsx,.pptx,audio/*,video/*");
  assert.equal(acceptFor(["text", "hologram"]), "text/*,.md,.json,.csv,.txt");
});

test("a 422 attachment_unsupported names each refused file's reason; other errors are not refusals", () => {
  const refusal = attachmentRefusal({
    status: 422,
    body: {
      code: "attachment_unsupported",
      message: "This model does not read one of the files.",
      details: { parts: [{ artifactId: "art_1", name: "clip.mp4", mediaType: "video/mp4", reason: "this model does not read video" }] },
    },
  });
  assert.equal(refusal?.message, "This model does not read one of the files.");
  assert.deepEqual([...refusal.reasons], [["art_1", "this model does not read video"]]);
  assert.equal(attachmentRefusal({ status: 422, body: { code: "invalid_request" } }), undefined);
  assert.equal(attachmentRefusal({ status: 413, body: { code: "attachment_unsupported" } }), undefined);
  assert.equal(attachmentRefusal(new Error("offline")), undefined);
  assert.equal(attachmentRefusal(undefined), undefined);
});

test("sizes read as bytes, KB and MB", () => {
  assert.equal(formatBytes(40), "40 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
