/**
 * Packed create-agent starter smoke (G7 / I2):
 * - Pack workspace tarballs including @nylorun/admin for CLI installs
 * - Install the packed Runtime as the developer prerequisite (`nylorun-runtime`
 *   on PATH); without it, `nylorun dev` names the install command
 * - `nylorun dev` and separate `nylorun-studio` (no `nylorun serve`)
 * - `npm start` = `node dist/src/main.js` with NYLORUN_* from Project link
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { root, npmCli, run } from "../../scripts/lib/repo.mjs";
import { ProcessGroup } from "../../scripts/lib/processes.mjs";
import { availablePort } from "../../scripts/lib/development.mjs";
import { installRuntime } from "../../scripts/lib/runtime-install.mjs";

// Hard wall-clock bound so a wedged CI runner/step cannot sit forever when
// Actions log upload already stalled (BlobNotFound while status=in_progress).
// Healthy smoke is ~2–4 min; allow headroom for slow runtime tarball extracts.
const SMOKE_DEADLINE_MS = Number(process.env.NYLORUN_SMOKE_DEADLINE_MS ?? 15 * 60_000);
const smokeDeadline = setTimeout(() => {
  console.error(
    `smoke-starter exceeded ${SMOKE_DEADLINE_MS}ms wall clock; aborting.`,
  );
  process.exit(2);
}, SMOKE_DEADLINE_MS);
smokeDeadline.unref?.();

const temporary = await mkdtemp(join(tmpdir(), "nylorun-release-"));
const group = new ProcessGroup();
let browser;
const projects = [];
const tarballs = process.env.NYLORUN_STACK_TARBALLS
  ? JSON.parse(await readFile(process.env.NYLORUN_STACK_TARBALLS, "utf8"))
  : {};
const names = [
  "core",
  "harness",
  "agents",
  "admin",
  "runtime",
  // @nylorun/studio is private: it ships only as the ghcr.io/nylorun/studio
  // image, so there is no Studio tarball.
  "cli",
  "create-agent",
];

const readyLine = (l) =>
  l.includes("Ready") || l.includes("Ctrl-C stops this Project only");
const studioOnLine = (l) => /^Studio on https?:\/\//.test(l);
const hostLine = (l) => /^\s*Host\s+http/.test(l);

function tokenFromLaunchUrl(launchUrl) {
  const hashIndex = launchUrl.indexOf("#");
  assert.ok(hashIndex >= 0, `launchUrl missing fragment: ${launchUrl}`);
  const params = new URLSearchParams(launchUrl.slice(hashIndex + 1));
  const token = params.get("token");
  assert.ok(token && /^[A-Za-z0-9_-]{43}$/.test(token), "launchUrl token");
  return token;
}

function proxyOriginFromLaunchUrl(launchUrl) {
  // Local: http://localhost:<port>/v/<version>/#…
  // Hosted: https://local.nylorun.studio/#…&port=
  if (launchUrl.startsWith("https://local.nylorun.studio")) {
    const hashIndex = launchUrl.indexOf("#");
    const params = new URLSearchParams(launchUrl.slice(hashIndex + 1));
    const port = params.get("port");
    assert.ok(port, "hosted launchUrl missing port");
    return `http://127.0.0.1:${port}`;
  }
  return new URL(launchUrl).origin;
}

try {
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  for (const name of names) {
    if (tarballs[name]) continue;
    const packed = JSON.parse(
      await run(
        process.execPath,
        [
          npmCli(),
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          artifacts,
        ],
        { cwd: join(root, name), capture: true },
      ),
    );
    tarballs[name] = join(artifacts, packed[0].filename);
  }
  await mkdir(join(root, ".tmp/release-local"), { recursive: true });
  const identities = {};
  for (const name of names)
    identities[name] = {
      file: tarballs[name].split("/").at(-1),
      sha256: createHash("sha256")
        .update(await readFile(tarballs[name]))
        .digest("hex"),
    };
  await writeFile(
    join(root, ".tmp/release-local/artifacts.json"),
    JSON.stringify(identities, null, 2) + "\n",
  );
  const creator = join(temporary, "creator");
  await mkdir(creator);
  await run("tar", ["-xzf", tarballs["create-agent"], "-C", creator]);
  const { starterFiles } = await import(
    pathToFileURL(join(creator, "package/dist/scaffold.js")).href
  );
  const pins = JSON.parse(
    await readFile(join(creator, "package/compatibility.json"), "utf8"),
  );
  for (const studio of [true, false]) {
    const project = join(temporary, studio ? "with-studio" : "headless");
    await mkdir(project);
    // The starter has no Studio dependency (W4b); W4c moves this smoke onto
    // the Docker stack and drops the headless/with-Studio split.
    const files = await starterFiles(pins);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
    const manifest = JSON.parse(files["package.json"]);
    assert.equal(manifest.scripts.dev, "nylorun dev");
    assert.equal(manifest.scripts.start, "node dist/src/main.js");
    assert.ok(!JSON.stringify(manifest.scripts).includes("serve"));
    for (const name of ["agents"])
      manifest.dependencies[`@nylorun/${name}`] = `file:${tarballs[name]}`;
    // Core is a transitive of agents; pin the workspace tarball for offline install.
    manifest.dependencies["@nylorun/core"] = `file:${tarballs.core}`;
    manifest.devDependencies ??= {};
    manifest.devDependencies["@nylorun/cli"] = `file:${tarballs.cli}`;
    // CLI depends on @nylorun/admin; pack the workspace tarball for offline install.
    manifest.devDependencies["@nylorun/admin"] = `file:${tarballs.admin}`;
    assert.equal(manifest.devDependencies["@nylorun/studio"], undefined);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify(manifest, null, 2),
    );
    await run(
      process.execPath,
      [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: project },
    );
    await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });
    projects.push(project);
  }

  const project = projects[0];
  const home = await mkdtemp(join(tmpdir(), "nylorun-release-home-"));
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-release-host-"));

  // Packaged @nylorun/studio no longer ships dist/web. Seed NYLORUN_HOME cache
  // from repo pack-ui so nylorun-studio --local-ui works without a live origin.
  await run(process.execPath, [join(root, "studio/scripts/pack-ui.mjs")], {
    cwd: join(root, "studio"),
  });
  const uiDigest = JSON.parse(
    await readFile(join(root, "studio/dist/ui-digest.json"), "utf8"),
  );
  assert.equal(typeof uiDigest.version, "string");
  assert.equal(typeof uiDigest.sha256, "string");
  const studioCache = join(hostRoot, "studio", uiDigest.version);
  await mkdir(studioCache, { recursive: true });
  await run("tar", [
    "-xf",
    join(root, "studio/dist/bundle.tar"),
    "-C",
    studioCache,
  ]);
  await writeFile(
    join(studioCache, "bundle.tar"),
    await readFile(join(root, "studio/dist/bundle.tar")),
  );

  // Fixture models are only allowed on ephemeral Hosts; release smoke uses
  // `--ephemeral` so NYLORUN_DEV_MODEL=fixture can drive Studio and SDK turns.
  // Prerequisite, as a developer does: the Runtime (packed candidate with its
  // packed @nylorun dependencies) installed and on PATH.
  const runtime = await installRuntime(join(temporary, "runtime"), [
    tarballs.runtime,
    tarballs.core,
    tarballs.harness,
  ]);
  const env = runtime.env({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NYLORUN_HOME: hostRoot,
    NYLORUN_DEV_MODEL: "fixture",
  });
  const readAuth = async (cwd) => {
    const credentials = JSON.parse(
      await readFile(join(cwd, ".nylorun/credentials.json"), "utf8"),
    );
    const link = JSON.parse(
      await readFile(join(cwd, ".nylorun/link.json"), "utf8"),
    );
    return { credentials, link };
  };
  /**
   * `dev` prints its ready banner before the application's connectAgents has
   * registered the seed agent. Studio creating a session in that window left
   * the session "loading" and the message box disabled (intermittent CI
   * failure). Poll the Tenant until it serves `assistant`, as the release
   * smoke does.
   */
  const waitForSeedAgent = async (cwd, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = "no response";
    while (Date.now() < deadline) {
      try {
        const { credentials, link } = await readAuth(cwd);
        const response = await fetch(`${link.hostUrl}/v1/agents`, {
          headers: {
            authorization: `Bearer ${credentials.applicationKey}`,
            "Nylorun-Tenant": link.tenantId,
            "Nylorun-Protocol": "2",
          },
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json();
        if (body.agents?.some((agent) => agent.manifest?.id === "assistant")) return;
        last = `HTTP ${response.status} agents=${JSON.stringify(
          body.agents?.map((agent) => agent.manifest?.id) ?? null,
        )}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Seed agent "assistant" was not served (${last}).`);
  };

  const studioBin = join(project, "node_modules/@nylorun/studio/dist/cli.js");
  const cliBin = join(project, "node_modules/@nylorun/cli/dist/cli.js");

  const dev = group.start(
    "generated-dev",
    process.execPath,
    [cliBin, "dev", "--ephemeral"],
    { cwd: project, env },
  );
  const hostBanner = await dev.line(hostLine, 90_000);
  const url = hostBanner.trim().replace(/^Host\s+/, "").split(/\s+/)[0];
  await dev.line(readyLine, 60_000);
  await waitForSeedAgent(project);
  const studio = group.start(
    "generated-studio",
    process.execPath,
    [studioBin, "--no-open", "--local-ui"],
    { cwd: project, env },
  );
  const studioBanner = await studio.line(studioOnLine, 90_000);
  const launchUrl = studioBanner.replace(/^Studio on\s+/, "").trim();
  const studioUrl = proxyOriginFromLaunchUrl(launchUrl);
  const token = tokenFromLaunchUrl(launchUrl);
  const { credentials } = await readAuth(project);
  assert.equal(
    (await stat(join(project, ".nylorun/credentials.json"))).mode & 0o777,
    0o600,
  );
  const hello = await (
    await fetch(`${studioUrl}/_studio/hello`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  assert.equal(hello.studioProtocol, 1);
  assert.equal(hello.mode, "local");
  assert.equal(
    hello.runtime?.compatible,
    true,
    `Studio hello runtime incompatible: ${hello.runtime?.message ?? "(no message)"}`,
  );
  assert.ok(!JSON.stringify(hello).includes(credentials.applicationKey));
  assert.ok(!JSON.stringify(hello).includes("executor"));
  // Token gate (I3): unauthenticated /_studio/* → 401 before allowlist 404.
  const unauthorized = await fetch(`${studioUrl}/_studio/runtime/v1/actions`);
  assert.equal(unauthorized.status, 401);
  const forbidden = await fetch(`${studioUrl}/_studio/runtime/v1/actions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(forbidden.status, 404);
  const csrf = await fetch(`${studioUrl}/_studio/runtime/v1/sessions/nope`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(csrf.status, 403);

  browser = await chromium.launch({
    executablePath:
      process.env.NYLORUN_CHROME_PATH ??
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  assert.match(
    launchUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/v\/[^/#]+\/#/,
    `local --local-ui launchUrl must be versioned on 127.0.0.1: ${launchUrl}`,
  );
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  try {
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click({ timeout: 30_000 });
  } catch (error) {
    const text = await page.locator("body").innerText().catch(() => "(no body)");
    await mkdir(join(root, ".tmp/release-local"), { recursive: true });
    await page.screenshot({
      path: join(root, ".tmp/release-local/studio-boot-fail.png"),
      fullPage: true,
    });
    throw new Error(
      `New session missing after goto ${launchUrl}\nURL now: ${page.url()}\npageerrors: ${JSON.stringify(errors)}\nbody:\n${text.slice(0, 2000)}\n${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    await page
      .getByRole("textbox", { name: "Message" })
      .fill("Look up order demo-123");
  } catch (error) {
    const text = await page.locator("body").innerText().catch(() => "(no body)");
    await mkdir(join(root, ".tmp/release-local"), { recursive: true });
    await page.screenshot({
      path: join(root, ".tmp/release-local/studio-message-fail.png"),
      fullPage: true,
    });
    throw new Error(
      `Message box stayed disabled after New session\npageerrors: ${JSON.stringify(errors)}\nbody:\n${text.slice(0, 2000)}\n${error instanceof Error ? error.message : error}`,
    );
  }
  await page.getByRole("button", { name: "Send", exact: true }).click();
  try {
    await page
      .getByText("Tool · lookup_order · completed", { exact: true })
      .waitFor({ timeout: 20000 });
  } catch (error) {
    const text = await page.locator("body").innerText();
    await page.screenshot({
      path: join(root, ".tmp/release-local/studio-fail.png"),
      fullPage: true,
    });
    throw new Error(
      `tool completion missing.\n${text.slice(0, 2000)}\n${error instanceof Error ? error.message : error}`,
    );
  }
  await page
    .getByText("Assistant", { exact: true })
    .first()
    .waitFor({ timeout: 20000 });
  assert.match(
    await page.locator("main").innerText(),
    /shipped|Order lookup complete/i,
  );
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("What did I ask earlier?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const transcript = page.locator("section").filter({
    has: page.getByRole("textbox", { name: "Message" }),
  });
  await transcript.getByText(/I remember:/).waitFor({ timeout: 20000 });
  const sessionUrl = page.url();
  const sessionId = sessionUrl.split("/").at(-1);
  await page.reload();
  await transcript.getByText(/I remember:/).waitFor({ timeout: 20000 });
  assert.match(await page.locator("main").innerText(), /demo-123/);
  assert.deepEqual(errors, []);
  await mkdir(join(root, ".tmp/release-local"), { recursive: true });
  await page.screenshot({
    path: join(root, ".tmp/release-local/studio.png"),
    fullPage: true,
  });

  const source = join(project, "agents/assistant/agent.ts");
  const beforeEditUrl = (await readAuth(project)).link.hostUrl;
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace(
      "Order assistant",
      "Updated order assistant",
    ),
  );
  // tsx watch restarts the Project entry on the same ephemeral Host; wait for
  // the renamed agent to re-register (link URL stays put).
  let afterEdit = await readAuth(project);
  let updated = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      afterEdit = await readAuth(project);
      assert.equal(
        afterEdit.link.hostUrl,
        beforeEditUrl,
        "source edit must keep the same ephemeral Host URL",
      );
      const response = await fetch(`${beforeEditUrl}/v1/agents`, {
        headers: {
          authorization: `Bearer ${afterEdit.credentials.applicationKey}`,
          "Nylorun-Tenant": afterEdit.link.tenantId,
          "Nylorun-Protocol": "2",
        },
      });
      const body = await response.json();
      if (
        body.agents?.some(
          (agent) => agent.manifest?.name === "Updated order assistant",
        )
      ) {
        updated = true;
        break;
      }
    } catch {
      /* link/agents may be briefly unavailable during restart */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(updated, "source edit restarted registry");
  const editUrl = afterEdit.link.hostUrl;
  await studio.stop();
  await dev.stop();
  await assert.rejects(fetch(`${editUrl}/health`));
  await stat(join(project, ".nylorun/credentials.json"));
  await stat(join(project, ".nylorun/link.json"));

  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });
  // Compiled start: runtime up + nylorun dev attach → npm start with link env.
  await rm(join(project, ".nylorun"), { recursive: true, force: true }).catch(
    () => {},
  );
  const up = group.start(
    "runtime-up",
    process.execPath,
    [cliBin, "runtime", "up"],
    { cwd: project, env },
  );
  assert.equal(await up.exit, 0, "runtime up must succeed");
  const attach = group.start(
    "dev-attach",
    process.execPath,
    [cliBin, "dev"],
    { cwd: project, env },
  );
  await attach.line(readyLine, 120_000);
  const linked = await readAuth(project);
  await attach.stop();
  const startEnv = {
    ...env,
    NYLORUN_RUNTIME_URL: linked.link.hostUrl,
    NYLORUN_TENANT: linked.link.tenantId,
    NYLORUN_SERVER_KEY: linked.credentials.applicationKey,
  };
  const started = group.start(
    "compiled-start",
    process.execPath,
    [npmCli(), "start"],
    { cwd: project, env: startEnv },
  );
  await new Promise((r) => setTimeout(r, 2000));
  const sdk = await import(
    pathToFileURL(join(project, "node_modules/@nylorun/agents/dist/index.js"))
      .href
  );
  const client = sdk.createClient({
    url: linked.link.hostUrl,
    key: linked.credentials.applicationKey,
    tenant: linked.link.tenantId,
  });
  const session = await client.createSession({
    agentId: "assistant",
    ownerUserId: "local-developer",
  });
  await session.input("Look up order demo-123", {
    idempotencyKey: crypto.randomUUID(),
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  let complete = false;
  try {
    for await (const event of session.observe({ signal: abort.signal })) {
      if (event.type === "turn.failed")
        throw new Error(JSON.stringify(event.payload));
      if (event.type === "turn.completed") {
        complete = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  assert.ok(complete, "compiled start executes a turn");
  void sessionId;
  void url;
  await started.stop();
  await run(
    process.execPath,
    [cliBin, "runtime", "down", "--force"],
    { cwd: project, env },
  ).catch(() => {});

  const headlessCli = join(
    projects[1],
    "node_modules/@nylorun/cli/dist/cli.js",
  );
  const headless = group.start(
    "headless-dev",
    process.execPath,
    [headlessCli, "dev", "--ephemeral"],
    { cwd: projects[1], env },
  );
  await headless.line(readyLine, 90_000);
  await headless.stop();

  // Fresh Project link for the unconfigured-model case — do not reuse the
  // headless Host URL (detached Host may still be draining; fetch would hang).
  await rm(join(projects[1], ".nylorun"), { recursive: true, force: true }).catch(
    () => {},
  );
  const missingPort = await availablePort();
  const missingHome = await mkdtemp(join(tmpdir(), "nylorun-release-missing-"));
  const missingEnv = runtime.env({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NYLORUN_HOME: missingHome,
    PORT: String(missingPort),
  });
  // No fixture and no MODEL_* — vault model stays unconfigured.
  delete missingEnv.NYLORUN_DEV_MODEL;
  const missing = group.start(
    "missing-config",
    process.execPath,
    [headlessCli, "dev", "--ephemeral"],
    {
      cwd: projects[1],
      env: missingEnv,
    },
  );
  // Require Host banner before Ready so we do not match a spurious "Ready"
  // during install and then hit a half-booted (or stale) link.
  const missingHostBanner = await missing.line(hostLine, 120_000);
  await missing.line(readyLine, 60_000);
  const missingAuth = await readAuth(projects[1]);
  assert.match(
    missingAuth.link.hostUrl,
    /^https?:\/\//,
    "missing-config must write a Host link",
  );
  const bannerUrl = missingHostBanner.trim().replace(/^Host\s+/, "").split(/\s+/)[0];
  assert.equal(
    missingAuth.link.hostUrl.replace(/\/$/, ""),
    bannerUrl.replace(/\/$/, ""),
    "Project link must match the Host banner for this missing-config run",
  );
  console.log(`missing-config: GET ${missingAuth.link.hostUrl}/v1/tenant/model`);
  await missing.ready(`${missingAuth.link.hostUrl}/health`, 30_000);
  // Belt-and-suspenders: some undici local hangs have ignored AbortSignal.
  const modelStatus = await Promise.race([
    fetch(`${missingAuth.link.hostUrl}/v1/tenant/model`, {
      headers: {
        authorization: `Bearer ${missingAuth.credentials.applicationKey}`,
        "Nylorun-Tenant": missingAuth.link.tenantId,
        "Nylorun-Protocol": "2",
      },
      signal: AbortSignal.timeout(15_000),
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("missing-config model fetch wall timeout (15s)")),
        15_000,
      ),
    ),
  ]);
  // Read the body once — assert message args are eager, so do not call
  // .text() inside the assertion message and then .json() afterward.
  const modelText = await modelStatus.text();
  assert.equal(
    modelStatus.status,
    200,
    `model status ${modelStatus.status}: ${modelText.slice(0, 500)}`,
  );
  const modelBody = JSON.parse(modelText);
  assert.equal(
    modelBody.configured,
    false,
    "expected unconfigured model without fixture/provider env",
  );
  console.log("missing-config: model configured=false ok");
  await missing.stop();
  await rm(missingHome, { recursive: true, force: true }).catch(() => {});

  // Prerequisite missing: with no Runtime on PATH, dev stops and names the
  // install command. Nothing is downloaded.
  const noRuntimeHome = await mkdtemp(join(tmpdir(), "nylorun-release-noruntime-"));
  const noRuntime = await run(
    process.execPath,
    [headlessCli, "dev", "--ephemeral"],
    {
      cwd: projects[1],
      capture: true,
      timeout: 60_000,
      env: {
        ...env,
        NYLORUN_HOME: noRuntimeHome,
        PATH: dirname(process.execPath),
      },
    },
  ).then(
    () => undefined,
    (error) => error,
  );
  assert.ok(noRuntime, "nylorun dev must fail without the Runtime on PATH");
  assert.match(
    `${noRuntime.stderr ?? ""}${noRuntime.stdout ?? ""}${noRuntime.message}`,
    /npm install --global @nylorun\/runtime@/,
  );
  await rm(noRuntimeHome, { recursive: true, force: true }).catch(() => {});
  console.log("no-runtime: dev names the install command ok");

  console.log(
    "PASS: packed creator, both starters (ephemeral Host + fixture), browser tool/results, source restart, compiled npm start, shutdown, credentials, missing-configuration error, and missing-Runtime prerequisite.",
  );
} finally {
  clearTimeout(smokeDeadline);
  await browser?.close();
  await group.close();
  await rm(temporary, { recursive: true, force: true });
}
