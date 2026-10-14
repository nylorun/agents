import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_ENVIRONMENT_FORM,
  environmentForm,
  forkForm,
  environmentRequest,
  isEnvironmentIdText,
  parseLabels,
} from "../web/src/environment-form.ts";

const form = (fields) => ({ ...EMPTY_ENVIRONMENT_FORM, ...fields });

test("an empty virtual form creates an Environment with the Tenant's defaults", () => {
  assert.deepEqual(environmentRequest(form({ id: "team/build" })), { kind: "virtual" });
});

test("a pod form sends its recipe, labels, owner guard and lifecycle", () => {
  assert.deepEqual(
    environmentRequest(
      form({
        id: "team/build",
        kind: "pod",
        image: " python:3.13-slim ",
        cpus: "2",
        memory: "2GiB",
        storage: "10GiB",
        allowedHosts: "PyPI.org, *.github.com\nfiles.pythonhosted.org pypi.org",
        labels: "project=build\nteam = a ",
        ownerUserId: "local-developer",
        idle: "15m",
        deleteAfter: "30d",
      }),
    ),
    {
      kind: "pod",
      labels: { project: "build", team: "a" },
      image: "python:3.13-slim",
      resources: { cpus: 2, memory: "2GiB" },
      storage: "10GiB",
      network: { allowedHosts: ["pypi.org", "*.github.com", "files.pythonhosted.org"] },
      ownerUserId: "local-developer",
      lifecycle: { idle: "15m", deleteAfter: "30d" },
    },
  );
});

test("kind none takes no sandbox fields; only a pod takes an image or storage", () => {
  assert.deepEqual(environmentRequest(form({ kind: "none", deleteAfter: "7d" })), {
    kind: "none",
    lifecycle: { deleteAfter: "7d" },
  });
  assert.throws(() => environmentRequest(form({ kind: "none", cpus: "1" })), /kind none/);
  assert.throws(() => environmentRequest(form({ kind: "none", allowedHosts: "a.example" })), /kind none/);
  assert.throws(() => environmentRequest(form({ image: "node:22" })), /Only a pod runs an image/);
  assert.throws(() => environmentRequest(form({ storage: "5GiB" })), /Only a pod has storage/);
});

test("refuses sizes, durations, CPUs and labels the Runtime would refuse, naming the field", () => {
  assert.throws(() => environmentRequest(form({ memory: "2GB" })), /Memory must be a size/);
  assert.throws(() => environmentRequest(form({ kind: "pod", storage: "lots" })), /Storage must be a size/);
  assert.throws(() => environmentRequest(form({ idle: "15 minutes" })), /Idle must be a duration/);
  assert.throws(() => environmentRequest(form({ deleteAfter: "0d" })), /Delete after must be a duration/);
  assert.throws(() => environmentRequest(form({ cpus: "1.5" })), /CPUs/);
  assert.throws(() => environmentRequest(form({ allowedHosts: "https://pypi.org" })), /not a host name/);
  assert.throws(() => parseLabels("project"), /key=value/);
});

test("an edit sends only labels and the owner guard: what it runs never changes; a cleared owner is null", () => {
  const view = {
    id: "team/build",
    kind: "pod",
    labels: { project: "build" },
    manifest: {
      image: "python:3.13-slim",
      resources: { cpus: 1, memory: "1024MiB" },
      storage: "5GiB",
      network: { allowedHosts: ["pypi.org"] },
      harness: "nylorun",
      lifecycle: { idle: "15m" },
    },
    version: 1,
    appliedVersion: 1,
    ownerUserId: "local-developer",
    state: "stopped",
    lastUsedAt: "2026-10-10T00:00:00.000Z",
    sessions: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
  const filled = environmentForm(view);
  assert.deepEqual(filled, {
    id: "team/build",
    kind: "pod",
    image: "python:3.13-slim",
    cpus: "1",
    memory: "1024MiB",
    storage: "5GiB",
    allowedHosts: "pypi.org",
    labels: "project=build",
    ownerUserId: "local-developer",
    idle: "15m",
    deleteAfter: "",
    harness: "",
    setup: [],
    files: [],
  });
  assert.deepEqual(environmentRequest({ ...filled, ownerUserId: "", idle: "", allowedHosts: "" }, view), {
    labels: { project: "build" },
    ownerUserId: null,
  });
});

const ARTIFACT = "af_01k7aaaaaaaaaaaaaaaaaaaaaa";

test("a pod's setup commands and input files are sent in order; empty rows are dropped", () => {
  assert.deepEqual(
    environmentRequest(
      form({
        id: "team/build",
        kind: "pod",
        setup: [
          { command: " pip install -r requirements.txt ", cwd: "/workspace/app", timeout: "15m" },
          { command: "", cwd: "", timeout: "" },
          { command: "make", cwd: "", timeout: "" },
        ],
        files: [{ artifactId: ARTIFACT, version: "2", path: "/workspace/data" }],
      }),
    ),
    {
      kind: "pod",
      setup: [
        { command: "pip install -r requirements.txt", cwd: "/workspace/app", timeout: "15m" },
        { command: "make" },
      ],
      files: [{ artifactId: ARTIFACT, version: 2, path: "/workspace/data" }],
    },
  );
});

test("refuses setup and files off a pod, and rows the Runtime would refuse, naming the row", () => {
  const setup = [{ command: "make", cwd: "", timeout: "" }];
  assert.throws(() => environmentRequest(form({ setup })), /Only a pod runs setup/);
  const pod = (fields) => form({ kind: "pod", ...fields });
  assert.throws(() => environmentRequest(pod({ setup: [{ command: "", cwd: "/workspace", timeout: "" }] })), /Setup command 1 has no command/);
  assert.throws(() => environmentRequest(pod({ setup: [{ command: "make", cwd: "/tmp", timeout: "" }] })), /directory must be \/workspace/);
  assert.throws(() => environmentRequest(pod({ setup: [{ command: "make", cwd: "/workspace/../etc", timeout: "" }] })), /directory/);
  assert.throws(() => environmentRequest(pod({ setup: [{ command: "make", cwd: "", timeout: "soon" }] })), /timeout must be a duration/);
  assert.throws(() => environmentRequest(pod({ files: [{ artifactId: "report", version: "1", path: "/workspace" }] })), /Input file 1 needs an artifact id/);
  assert.throws(() => environmentRequest(pod({ files: [{ artifactId: ARTIFACT, version: "0", path: "/workspace" }] })), /needs a version/);
  assert.throws(() => environmentRequest(pod({ files: [{ artifactId: ARTIFACT, version: "1", path: "data" }] })), /path must be \/workspace/);
  const many = Array.from({ length: 17 }, () => ({ command: "true", cwd: "", timeout: "" }));
  assert.throws(() => environmentRequest(pod({ setup: many })), /at most 16 setup commands/);
});

test("a harness id is sent when set, and an existing one's harness fills the form", () => {
  assert.deepEqual(environmentRequest(form({ harness: "codex" })), { kind: "virtual", harness: "codex" });
  assert.throws(() => environmentRequest(form({ harness: "Codex CLI" })), /Harness must be a harness id/);
  const view = { kind: "virtual", manifest: { harness: "codex", lifecycle: {} } };
  assert.equal(environmentRequest(form({ harness: "" }), view).harness, undefined);
  assert.equal(environmentForm({ ...view, id: "a", labels: {}, ownerUserId: null }).harness, "codex");
});

test("a new Environment can start from another's disk version: the source's recipe, no owner guard", () => {
  const source = {
    id: "team/build",
    kind: "pod",
    labels: { project: "build" },
    manifest: { harness: "nylorun", lifecycle: {}, storage: "5GiB" },
    ownerUserId: "local-developer",
  };
  const fork = forkForm(source, "team/build-copy");
  assert.equal(fork.id, "team/build-copy");
  assert.equal(fork.ownerUserId, "");
  assert.deepEqual(environmentRequest(fork, undefined, { environment: "team/build", version: 3 }), {
    kind: "pod",
    labels: { project: "build" },
    storage: "5GiB",
    from: { environment: "team/build", version: 3 },
  });
  assert.throws(
    () => environmentRequest(fork, source, { environment: "team/build", version: 3 }),
    /Only a new Environment starts from a disk version/,
  );
  assert.throws(
    () => environmentRequest(form({ kind: "none" }), undefined, { environment: "a", version: 1 }),
    /kind none has no disk/,
  );
});

test("an Environment id is /-separated segments of letters, digits, '.', '_' and '-'", () => {
  for (const id of ["team/build", "users/alice/web", "a", "x.y_z-1"]) assert.equal(isEnvironmentIdText(id), true, id);
  for (const id of ["", "/a", "a/", "a//b", "-a", "a b", "a".repeat(201)]) assert.equal(isEnvironmentIdText(id), false, id);
});
