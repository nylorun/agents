import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "../web/src/attachments.ts";

test("sizes read as bytes, KB and MB", () => {
  assert.equal(formatBytes(40), "40 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
