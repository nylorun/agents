import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { root, readJson, run } from "../lib/repo.mjs";
import { publicCreatorSmoke } from "./smoke.mjs";
import {
  validatePlan,
  verifyReleaseCommit,
  publishCandidates,
  releaseNotes,
} from "./model.mjs";
import { readArtifacts } from "./artifacts.mjs";
import { registry } from "./registry.mjs";


try {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RELEASE_SHA)
    throw new Error(
      "Publication is only available through the manual GitHub release workflow.",
    );
  await verifyReleaseCommit(root, process.env.RELEASE_SHA);
  const plan = await readJson(join(root, ".release/plan.json"));
  await validatePlan(plan, root);
  const artifacts = await readArtifacts(
    join(root, ".tmp/release-artifacts"),
    plan,
  );
  const notesByPackage = Object.fromEntries(
    await Promise.all(
      Object.entries(plan.packages).map(async ([name, version]) => [
        name,
        await releaseNotes(root, name, version),
      ]),
    ),
  );
  // Reject conflicting tags before any registry write; publication cannot be undone.
  // Version tags are immutable once cut. A different SHA is expected when promoting
  // an already-published version onto another npm channel (e.g. beta → latest).
  const priorVersionTags = new Set();
  for (const [name, version] of Object.entries(plan.packages)) {
    const tag = `@nylorun/${name}@${version}`;
    const existing = await run(
      "git",
      [
        "ls-remote",
        "--tags",
        "origin",
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ],
      { capture: true },
    );
    if (!existing) continue;
    const lines = existing.split("\n");
    const target = (
      lines.find((line) => line.endsWith("^{}")) ?? lines[0]
    ).split(/\s+/)[0];
    if (target === process.env.RELEASE_SHA) continue;
    // Image-only packages are not on npm. The workflow's images job already
    // required their image to exist, and never replaces an existing tag.
    const published = artifacts[name].image
      ? true
      : await registry.lookup(name, version);
    if (!published)
      throw new Error(`Tag ${tag} points to a different commit.`);
    priorVersionTags.add(name);
  }
  const messages = [];
  try {
    await publishCandidates(
      plan,
      artifacts,
      registry,
      (message) => {
        messages.push(message);
        console.log(message);
      },
    );
    await publicCreatorSmoke(
      plan.packages["create-agent"],
      plan.compatibility.runtime,
    );
    const temporary = await mkdtemp(join(tmpdir(), "nylorun-release-notes-"));
    try {
      for (const [name, version] of Object.entries(plan.packages)) {
        const tag = `@nylorun/${name}@${version}`;
        const notes = join(temporary, `${name}.md`);
        await writeFile(
          notes,
          `${notesByPackage[name]}\n\nPublished from ${process.env.RELEASE_SHA}.\n`,
        );
        let releaseExists = false;
        const releases = JSON.parse(
          await run(
            "gh",
            [
              "api",
              `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
            ],
            { capture: true },
          ).catch((error) => {
            if (/HTTP 404/.test(error.message)) return "null";
            throw error;
          }),
        );
        releaseExists = releases !== null;
        // Skip when the version tag/release already exists from a prior channel
        // publication; promotion commits must not retarget immutable version tags.
        if (!releaseExists && !priorVersionTags.has(name))
          await run("gh", [
            "release",
            "create",
            tag,
            "--target",
            process.env.RELEASE_SHA,
            "--title",
            tag,
            "--notes-file",
            notes,
            "--latest=false",
            // Pre-1.0 product versions stay *-beta even on the latest npm channel.
            ...(String(version).includes("-") ? ["--prerelease"] : []),
          ]);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        messages.map((line) => `- ${line}`).join("\n") +
          "\n\nIf incomplete, rerun this workflow for the same commit. Matching publications are retained.\n",
      );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
