import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { root, run, npm, readJson, verifyToolchain } from "./lib/repo.mjs";

await verifyToolchain();
const temporary = await mkdtemp(join(tmpdir(), "nylorun-setup-smoke-"));
const home = await mkdtemp(join(tmpdir(), "nylorun-setup-home-"));
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
const previousNylorun = process.env.NYLORUN_HOME;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.NYLORUN_HOME;
try {
  const files = (
    await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      capture: true,
    })
  )
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    try {
      await mkdir(dirname(join(temporary, file)), { recursive: true });
      await cp(join(root, file), join(temporary, file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const sentinels = {
    "examples/.env/auth.json": '{"fixture":"must-not-change"}',
    "examples/config/model.json": '{"fixture":"must-not-change"}',
    "examples/.data/sentinel.txt": "must-not-change",
  };
  for (const [file, content] of Object.entries(sentinels)) {
    await mkdir(dirname(join(temporary, file)), { recursive: true });
    await writeFile(join(temporary, file), content);
  }
  const protectedFiles = new Set([
    ...files.filter(
      (file) =>
        file.startsWith("examples/agents/") || file.startsWith("examples/test/"),
    ),
    "examples/.scaffold-manifest.json",
    "package-lock.json",
    "examples/package-lock.json",
    ...Object.keys(sentinels),
  ]);
  const before = new Map();
  for (const file of protectedFiles)
    before.set(file, await readFile(join(temporary, file)));
  await npm(["run", "setup"], { cwd: temporary });
  for (const [file, content] of before)
    assert.deepEqual(
      await readFile(join(temporary, file)),
      content,
      `Setup modified ${file}`,
    );
  // Starter scripts: tsx watch on the linked Tenant, no serve, and no Studio
  // script (Studio runs in the stack; `nylorun studio` opens it).
  const starterPkg = await readJson(
    join(temporary, "create-agent/starter/package.json"),
  );
  assert.equal(starterPkg.scripts.dev, "tsx watch --env-file-if-exists=.env src/main.ts");
  assert.equal(starterPkg.scripts.studio, undefined);
  assert.equal(starterPkg.scripts.start, "node dist/src/main.js");
  assert.ok(
    !Object.values(starterPkg.scripts).some((script) =>
      String(script).includes("serve"),
    ),
    "starter must not call nylorun serve",
  );
  console.log(
    "Clean-checkout setup passed; authored agents, tests, shell provenance, lockfiles, and local state are unchanged.",
  );
  const compatibility = await readJson(
    join(temporary, "create-agent/compatibility.json"),
  );
  // Exercise one release independently of pending intents in the source PR.
  for (const file of await readdir(join(temporary, ".changeset"))) {
    if (file.endsWith(".md")) await rm(join(temporary, ".changeset", file));
  }
  await writeFile(
    join(temporary, ".changeset/runtime-fixture.md"),
    '---\n"@nylorun/runtime": patch\n---\n\nExercise controlled release preparation.\n',
  );
  const git = (args) => run("git", args, { cwd: temporary, capture: true });
  await git(["init", "-b", "main"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Release fixture",
  ]);
  await git(["switch", "-c", "codex/release-fixture"]);
  await npm(["run", "release:prepare"], {
    cwd: temporary,
  });
  const plan = await readJson(join(temporary, ".release/plan.json"));
  // A Runtime release reaches developers through nylorun, which pins its image.
  assert.deepEqual(Object.keys(plan.packages).sort(), [
    "create-agent",
    "nylorun",
    "runtime",
  ]);
  assert.notEqual(plan.packages.runtime, compatibility.runtime);
  assert.equal(plan.compatibility.harness, compatibility.harness);
  assert.equal(plan.compatibility.studio, compatibility.studio);
  const provenance = await readJson(
    join(temporary, "examples/.scaffold-manifest.json"),
  );
  assert.equal(provenance.creatorVersion, plan.packages["create-agent"]);
  assert.equal(provenance.compatibility.runtime, plan.packages.runtime);
  for (const [file, content] of before) {
    if (
      file.endsWith("package-lock.json") ||
      file.endsWith(".scaffold-manifest.json")
    )
      continue;
    assert.deepEqual(
      await readFile(join(temporary, file)),
      content,
      `Release preparation modified authored/local file ${file}`,
    );
  }
  assert.equal(await git(["log", "-1", "--format=%s"]), "Release fixture");
  console.log(
    "Release preparation smoke passed: creator adoption, generated provenance, npm lockfile refresh, preserved authored/local files, and no automatic commit.",
  );
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  if (previousNylorun === undefined) delete process.env.NYLORUN_HOME;
  else process.env.NYLORUN_HOME = previousNylorun;
  await rm(temporary, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
