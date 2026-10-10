import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { virtualBackend } from "../../src/adapters/sandbox/virtual.js";
import { conformance } from "./conformance.js";

conformance("virtual", {
  backend: () => virtualBackend({ root: mkdtempSync(join(tmpdir(), "nylorun-virtual-")) }),
  fetch: (url) => `curl -sS -o /dev/null -w '%{http_code}' '${url}'`,
  network: process.env.NYLORUN_TEST_NETWORK === "1",
});
