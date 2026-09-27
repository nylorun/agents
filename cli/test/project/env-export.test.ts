import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/agents";
import { printLinkedEnvExports } from "../../src/project/env.js";
import { writeLink } from "../../src/project/link.js";
import { writeCredentials } from "../../src/project/credentials.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("F2-7: prints three export lines for a linked Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-env-export-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), "{}");
  const tenantId = newTenantId();
  await writeLink(root, {
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_01habcdefghijklmnopqrstuvw",
    tenantId,
  });
  await writeCredentials(root, {
    applicationKey: "ab".repeat(32),
    principalId: "principal_x",
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await printLinkedEnvExports(root);
  } finally {
    console.log = original;
  }
  expect(lines).toEqual([
    "export NYLORUN_RUNTIME_URL=http://127.0.0.1:8787",
    `export NYLORUN_SERVER_KEY=${"ab".repeat(32)}`,
    `export NYLORUN_TENANT=${tenantId}`,
  ]);
});
