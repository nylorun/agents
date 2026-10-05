import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, npm, packageName, run } from "./lib/repo.mjs";
const temporary = await mkdtemp(join(tmpdir(), "nylorun-isolated-"));
try {
  const packed = {};
  for (const name of ["core", "harness", "agents", "runtime"]) {
    const result = JSON.parse(
      await npm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
        { cwd: join(root, name), capture: true }
      )
    );
    packed[name] = join(temporary, result[0].filename);
  }
  for (const [name, deps, forbidden] of [
    ["sdk", ["core", "agents"], ["harness", "runtime", "nylorun", "cli"]],
    ["host", ["core", "harness", "runtime"], ["agents", "nylorun", "cli", "studio"]],
  ]) {
    const cwd = join(temporary, name);
    await mkdir(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ private: true, type: "module" })
    );
    await npm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...deps.map((dep) => packed[dep]),
      ],
      { cwd, capture: true }
    );
    for (const dependency of forbidden)
      await assert.rejects(
        access(join(cwd, "node_modules", packageName(dependency)))
      );
    const source =
      name === "sdk"
        ? `
      import assert from 'node:assert/strict';
      import { Agent } from '@nylorun/agents/define';
      import { createClient } from '@nylorun/agents/client';
      import { createActionHandler } from '@nylorun/agents';
      import { createAgUiHandler, toNodeListener } from '@nylorun/agents/ag-ui';
      assert.equal(Agent({id:'isolated',name:'Isolated'}).manifest.id, 'isolated');
      assert.equal(typeof createClient, 'function');
      assert.equal(typeof createActionHandler, 'function');
      await assert.rejects(import('@nylorun/agents/executor'));
      assert.equal(typeof createAgUiHandler, 'function');
      assert.equal(typeof toNodeListener, 'function');
    `
        : `
      // The Host entry needs Postgres (and the rest of the Compose services), so here it
      // only has to load in isolation and refuse to start without a database.
      import assert from 'node:assert/strict';
      import { fork } from 'node:child_process';
      import { randomBytes } from 'node:crypto';
      import { mkdir, writeFile } from 'node:fs/promises';
      import { createRequire } from 'node:module';
      import { join } from 'node:path';
      import { openTenantRuntime } from '@nylorun/runtime';
      import openapi from '@nylorun/runtime/openapi.json' with { type: 'json' };
      import management from '@nylorun/runtime/management-openapi.json' with { type: 'json' };
      assert.equal(typeof openTenantRuntime, 'function');
      assert.equal(openapi.openapi, '3.2.0');
      // Named components: the contracts' schemas reached zod-to-openapi as one Zod.
      assert.ok(openapi.components.schemas.SessionView);
      assert.equal(management.info.title, 'Nylorun Management API');
      const hostRoot = join(process.cwd(), 'host-root');
      await mkdir(join(hostRoot, 'home'), { recursive: true });
      await mkdir(join(hostRoot, 'tmp'), { recursive: true });
      await mkdir(join(hostRoot, 'tenant'), { recursive: true });
      // host_ + 26 Crockford chars (matches HOST_ID_PATTERN).
      const hostId = 'host_00000000000000000000000000';
      await writeFile(join(hostRoot, 'host.json'), JSON.stringify({
        hostId, host: '127.0.0.1', port: 0,
      }));
      await writeFile(join(hostRoot, 'host-credentials.json'), JSON.stringify({
        adminKey: randomBytes(32).toString('hex'),
      }));
      const child = fork(createRequire(import.meta.url).resolve('@nylorun/runtime/server'), [], {
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          TZ: process.env.TZ,
          HOME: join(hostRoot, 'home'),
          USERPROFILE: join(hostRoot, 'home'),
          TMPDIR: join(hostRoot, 'tmp'),
          NYLORUN_HOME: hostRoot,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Isolated runtime did not exit'));
        }, 20000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.equal(code, 1, stderr);
      assert.match(stderr, /NYLORUN_DATABASE_URL is required/);
    `;
    await writeFile(join(cwd, "check.mjs"), source);
    await run(process.execPath, ["check.mjs"], {
      cwd,
      capture: true,
      timeout: 30000,
    });
    console.log(
      `Isolated ${name} tarball installation passed without ${forbidden.join(
        ", "
      )}.`
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
