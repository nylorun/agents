import assert from "node:assert/strict";
import test from "node:test";
import {
  INLINE_MANIFEST,
  environmentFilter,
  environmentGroups,
  environmentsPath,
  filterEnvironments,
  labelsOf,
  manifestOf,
} from "../web/src/environment-list.ts";

const environment = (id, manifestName, labels = {}) => ({
  id,
  labels,
  ...(manifestName === undefined ? {} : { manifestName, manifestVersion: 1 }),
});
const manifest = (name, version = 1) => ({
  name,
  version,
  manifest: { name, kind: "virtual" },
  environments: 0,
  createdAt: "2026-10-15T00:00:00.000Z",
  savedBy: { actor: "studio" },
});

test("the list is filtered to a manifest, inline fields or labels by its query", () => {
  assert.equal(environmentsPath(), "/environments");
  assert.equal(environmentsPath({ manifest: "analyst-box" }), "/environments?manifest=analyst-box");
  assert.equal(environmentsPath({ manifest: INLINE_MANIFEST }), "/environments?manifest=-");
  assert.equal(
    environmentsPath({ manifest: "a", labels: ["project=build", "team=x"] }),
    "/environments?manifest=a&label=project%3Dbuild&label=team%3Dx",
  );
  assert.deepEqual(environmentFilter("?manifest=a&label=project%3Dbuild&label=bad"), {
    manifest: "a",
    labels: ["project=build"],
  });
  assert.deepEqual(environmentFilter(""), { labels: [] });
  assert.deepEqual(environmentFilter("?manifest="), { labels: [] });
});

test("an Environment is in its manifest's group, or in inline fields'", () => {
  assert.equal(manifestOf(environment("a", "box")), "box");
  assert.equal(manifestOf(environment("a")), INLINE_MANIFEST);
  assert.deepEqual(labelsOf(environment("a", undefined, { team: "x", project: "build" })), [
    "project=build",
    "team=x",
  ]);
});

test("the filter keeps the Environments of its manifest with every label", () => {
  const all = [
    environment("a", "box", { project: "build" }),
    environment("b", "box"),
    environment("c", undefined, { project: "build" }),
    environment("d", "other", { project: "build", team: "x" }),
  ];
  const ids = (filter) => filterEnvironments(all, filter).map((e) => e.id);
  assert.deepEqual(ids({ labels: [] }), ["a", "b", "c", "d"]);
  assert.deepEqual(ids({ manifest: "box", labels: [] }), ["a", "b"]);
  assert.deepEqual(ids({ manifest: INLINE_MANIFEST, labels: [] }), ["c"]);
  assert.deepEqual(ids({ labels: ["project=build"] }), ["a", "c", "d"]);
  assert.deepEqual(ids({ manifest: "other", labels: ["project=build", "team=x"] }), ["d"]);
  assert.deepEqual(ids({ manifest: "box", labels: ["team=x"] }), []);
});

test("groups are the saved manifests, then manifests only Environments name, then inline fields", () => {
  const groups = environmentGroups(
    [manifest("zeta"), manifest("analyst-box", 3), manifest("unused")],
    [
      environment("a", "zeta"),
      environment("b", "zeta"),
      environment("c", "gone"),
      environment("d"),
      environment("e", "analyst-box"),
    ],
  );
  assert.deepEqual(
    groups.map(({ id, name, count, manifest }) => [id, name, count, manifest?.version]),
    [
      ["analyst-box", "analyst-box", 1, 3],
      ["unused", "unused", 0, 1],
      ["zeta", "zeta", 2, 1],
      ["gone", "gone", 1, undefined],
      [INLINE_MANIFEST, "Inline fields", 1, undefined],
    ],
  );
  // No inline group when no Environment was made from inline fields.
  assert.deepEqual(
    environmentGroups([], [environment("a", "box")]).map((group) => group.id),
    ["box"],
  );
});
