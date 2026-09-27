import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, readJson } from "../lib/repo.mjs";
import { renderPreview } from "../starter.mjs";

test("starter previews resolve local packages and never overwrite an earlier preview", async () => {
  const first = await renderPreview();
  let second;
  try {
    const manifest = await readJson(join(first, "package.json"));
    assert.equal(
      manifest.dependencies["@nylorun/runtime"],
      `file:${join(root, "runtime").replaceAll("\\", "/")}`,
    );
    // Studio runs in the Docker stack; previews never depend on it.
    assert.equal(manifest.devDependencies["@nylorun/studio"], undefined);
    await writeFile(
      join(first, "agents/assistant/agent.ts"),
      "authored preview",
    );
    await writeFile(join(first, ".env"), "MODEL_PROVIDER_API_KEY=local-only\n");
    second = await renderPreview();
    assert.notEqual(first, second);
    assert.equal(
      await readFile(join(first, "agents/assistant/agent.ts"), "utf8"),
      "authored preview",
    );
    assert.equal(
      await readFile(join(first, ".env"), "utf8"),
      "MODEL_PROVIDER_API_KEY=local-only\n",
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    if (second) await rm(second, { recursive: true, force: true });
  }
});
