import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { runCommand, CreationCancelled } from "../dist/process.js";

it("the real CLI rejects unknown options before making the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-cli-"));
  try {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "demo", "--skip-config"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (data) => {
      output += data;
    });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(status).toBe(1);
    expect(output).toContain("Usage:");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["SIGINT", "SIGTERM"] as const)(
  "forwards %s to the whole command tree and removes cancellation listeners",
  async (signal) => {
    const root = await mkdtemp(join(tmpdir(), "creator-tree-"));
    const controller = new AbortController();
    try {
      // Like npm, the parent exits before the child finishes graceful cleanup.
      await writeFile(
        join(root, "parent.mjs"),
        `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'); process.on('SIGINT',stop); process.on('SIGTERM',stop); function stop(){setTimeout(()=>{fs.writeFileSync('closed','yes');process.exit(0)},75)}; fs.writeFileSync('ready', String(process.pid)); setInterval(()=>{},1000)"], {stdio:'inherit'});
process.on('SIGINT',()=>process.exit(130));
process.on('SIGTERM',()=>process.exit(143));
`,
      );
      const running = runCommand(
        process.execPath,
        [join(root, "parent.mjs")],
        root,
        controller.signal,
      );
      const rejected = expect(running).rejects.toMatchObject({
        exitCode: signal === "SIGINT" ? 130 : 143,
      });
      await expect
        .poll(async () => readFile(join(root, "ready"), "utf8"), {
          timeout: 3000,
        })
        .toMatch(/^\d+$/);
      controller.abort(new CreationCancelled(signal));
      await rejected;
      expect(await readFile(join(root, "closed"), "utf8")).toBe("yes");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort(new CreationCancelled("SIGTERM"));
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
