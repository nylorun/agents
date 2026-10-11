import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_ENVIRONMENT_FORM,
  environmentForm,
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

test("an edit sends the recipe as the form holds it, never kind or storage; a cleared owner is null", () => {
  const view = {
    id: "team/build",
    kind: "pod",
    labels: { project: "build" },
    recipe: {
      image: "python:3.13-slim",
      resources: { cpus: 1, memory: "1024MiB" },
      storage: "5GiB",
      network: { allowedHosts: ["pypi.org"] },
      harness: "nylorun",
      lifecycle: { idle: "15m" },
    },
    version: 2,
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
  });
  assert.deepEqual(environmentRequest({ ...filled, ownerUserId: "", idle: "", allowedHosts: "" }, view), {
    labels: { project: "build" },
    image: "python:3.13-slim",
    resources: { cpus: 1, memory: "1024MiB" },
    network: { allowedHosts: [] },
    ownerUserId: null,
    lifecycle: {},
  });
});

test("an Environment id is /-separated segments of letters, digits, '.', '_' and '-'", () => {
  for (const id of ["team/build", "users/alice/web", "a", "x.y_z-1"]) assert.equal(isEnvironmentIdText(id), true, id);
  for (const id of ["", "/a", "a/", "a//b", "-a", "a b", "a".repeat(201)]) assert.equal(isEnvironmentIdText(id), false, id);
});
