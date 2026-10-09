import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { printLinkedEnvExports } from "../../../src/client/project/env.js";
import { APPLICATION_KEY, link3, project, writeProjectLink } from "../helpers/project.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function capture(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

it("F2-7: prints the Runtime URL and the server key, and no Tenant", async () => {
  const root = await project("nylorun-env-export-");
  roots.push(root);
  await writeProjectLink(root, link3("http://127.0.0.1:8787"));
  const lines = await capture(() => printLinkedEnvExports(root));
  expect(lines).toEqual([
    "export NYLORUN_RUNTIME_URL=http://127.0.0.1:8787",
    `export NYLORUN_SERVER_KEY=${APPLICATION_KEY}`,
  ]);
  expect(lines.join("\n")).not.toContain("NYLORUN_TENANT");
});

it("without a link it says to run nylorun start", async () => {
  const root = await project("nylorun-env-export-");
  roots.push(root);
  const lines = await capture(() => printLinkedEnvExports(root));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^# No Project link/);
  expect(lines[0]).toContain("npx nylorun start");
});
