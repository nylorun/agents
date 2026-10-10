import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATOR_PINS,
  isBreakingBump,
  parseProtocolConstants,
  planVersions,
  protocolEquals,
} from "../release/version-policy.mjs";
import { packageDirectory, packageName } from "../lib/repo.mjs";

const versions = {
  core: "0.1.0-beta.1",
  cli: "0.1.0-beta.1",
  harness: "0.10.0-beta.1",
  agents: "0.1.0-beta.1",
  admin: "0.1.0-beta.1",
  runtime: "0.1.0-beta.1",
  studio: "0.3.0-beta.1",
  nylorun: "0.1.0-beta.1",
  "create-agent": "0.1.0-beta.1",
};
const pins = {
  core: versions.core,
  harness: versions.harness,
  agents: versions.agents,
  admin: versions.admin,
  runtime: versions.runtime,
};
const intent = (name, type = "patch") => ({
  id: `change-${name}`,
  summary: "Change behavior.",
  releases: [{ name: packageName(name), type }],
});

test("the migration computes the approved package targets and exact pins", () => {
  const { plan, releases } = planVersions(
    versions,
    pins,
    [
      intent("harness", "minor"),
      intent("runtime"),
      intent("studio", "minor"),
      intent("create-agent", "minor"),
    ]
  );
  assert.deepEqual(plan.packages, {
    nylorun: "0.1.1-beta",
    cli: "0.1.1-beta",
    harness: "0.11.0-beta",
    runtime: "0.1.1-beta",
    studio: "0.4.0-beta",
    "create-agent": "0.2.0-beta",
  });
  for (const name of CREATOR_PINS)
    assert.equal(plan.compatibility[name], plan.packages[name] ?? versions[name]);
  // Studio ships as an image nylorun pins; the creator pins neither.
  assert.deepEqual(Object.keys(plan.compatibility).sort(), [...CREATOR_PINS].sort());
  for (const release of releases)
    assert.equal(release.newVersion, plan.packages[packageDirectory(release.name)]);
});

for (const [before, type, expected] of [
  ["0.11.0-beta", "patch", "0.11.1-beta"],
  ["0.11.0-beta", "minor", "0.12.0-beta"],
  ["0.11.0-beta", "major", "0.12.0-beta"],
  ["1.2.3-beta", "major", "2.0.0-beta"],
  ["0.11.0", "patch", "0.11.1-beta"],
  ["0.11.0-beta.8", "patch", "0.11.1-beta"],
])
  test(`${before} with ${type} intent becomes ${expected}`, () => {
    assert.equal(
      planVersions(
        { ...versions, harness: before },
        pins,
        [intent("harness", type)]
      ).plan.packages.harness,
      expected
    );
  });

test("creator-only releases retain the exact compatibility combination", () => {
  const { plan } = planVersions(
    versions,
    pins,
    [intent("create-agent")]
  );
  assert.deepEqual(plan.packages, { "create-agent": "0.1.1-beta" });
  assert.deepEqual(plan.compatibility, pins);
});

test("the strongest intent wins without double-counting changesets", () => {
  const changes = [
    intent("harness"),
    { ...intent("harness", "minor"), id: "feature" },
  ];
  assert.equal(
    planVersions(versions, pins, changes).plan.packages.harness,
    "0.11.0-beta"
  );
});

test("invalid inputs and empty release intent fail before applying a plan", () => {
  assert.throws(() => planVersions(versions, pins, []), /No pending/);
  assert.throws(
    () => planVersions({ ...versions, runtime: "invalid" }, pins, []),
    /Invalid current/
  );
  assert.throws(
    () => planVersions(versions, pins, [intent("unknown")]),
    /Unsupported/
  );
  assert.throws(
    () => planVersions(versions, pins, [intent("runtime", "invalid")]),
    /Unsupported/
  );
  const stable = Object.fromEntries(
    Object.keys(versions).map((name) => [name, "1.0.0"])
  );
  assert.throws(() => planVersions(stable, pins, []), /No pending/);
});

test("a Harness release also advances Runtime and pins the canonical contracts together", () => {
  const { plan, changesets } = planVersions(versions, pins, [intent("harness", "minor")]);
  assert.equal(plan.packages.harness, "0.11.0-beta");
  assert.equal(plan.packages.runtime, "0.1.1-beta");
  assert.equal(plan.compatibility.harness, plan.packages.harness);
  assert.ok(changesets.some(item => item.id === "release-runtime-harness"));
});


test("a Studio release advances nylorun, which pins its image, the deprecated CLI and the creator", () => {
  const { plan, changesets } = planVersions(versions, pins, [intent("studio", "minor")]);
  assert.deepEqual(plan.packages, {
    nylorun: "0.1.1-beta",
    cli: "0.1.1-beta",
    studio: "0.4.0-beta",
    "create-agent": "0.1.1-beta",
  });
  assert.ok(changesets.some((item) => item.id === "release-nylorun-studio"));
  assert.ok(changesets.some((item) => item.id === "release-cli-nylorun"));
  // Neither nylorun nor Studio is a creator pin: the generated project installs neither.
  assert.deepEqual(plan.compatibility, pins);
});

test("a Runtime release advances nylorun, which pins its image, and the CLI, which pins nylorun", () => {
  const { plan } = planVersions(versions, pins, [intent("runtime")]);
  assert.equal(plan.packages.nylorun, "0.1.1-beta");
  assert.equal(plan.packages.cli, "0.1.1-beta");
  assert.equal(plan.compatibility.cli, undefined);
});

test("an Admin release advances Studio and nylorun, which depend on it, and not the SDK", () => {
  const { plan, changesets } = planVersions(versions, pins, [intent("admin", "minor")]);
  assert.deepEqual(plan.packages, {
    admin: "0.2.0-beta",
    studio: "0.3.1-beta",
    nylorun: "0.1.1-beta",
    cli: "0.1.1-beta",
    "create-agent": "0.1.1-beta",
  });
  assert.ok(changesets.some((item) => item.id === "release-studio-admin"));
  assert.ok(changesets.some((item) => item.id === "release-nylorun-admin"));
  assert.equal(plan.compatibility.admin, "0.2.0-beta");
});

test("the creator pins exactly core, harness, agents, admin and runtime", () => {
  assert.deepEqual([...CREATOR_PINS], ["core", "harness", "agents", "admin", "runtime"]);
  assert.throws(
    () => planVersions(versions, { ...pins, cli: versions.cli }, [intent("runtime")]),
    /exactly the valid creator pins/,
  );
  assert.throws(
    () => planVersions(versions, { ...pins, studio: versions.studio }, [intent("runtime")]),
    /exactly the valid creator pins/,
  );
  const { runtime: _runtime, ...missing } = pins;
  assert.throws(
    () => planVersions(versions, missing, [intent("cli")]),
    /exactly the valid creator pins/,
  );
});

test("core releases propagate to both hosts and SDK without coupling engine releases to SDK", () => {
  const shared = planVersions(versions, pins, [intent("core", "minor")]).plan;
  for (const name of ["core", "harness", "agents", "runtime", "studio", "nylorun", "cli", "create-agent"])
    assert.ok(shared.packages[name], `${name} must receive its updated dependency pin`);
  const engine = planVersions(versions, pins, [intent("harness")]).plan;
  assert.equal(engine.packages.agents, undefined);
  assert.equal(engine.packages.studio, undefined);
  assert.ok(engine.packages.runtime);
  assert.ok(engine.packages.nylorun);
  // The deprecated CLI follows the nylorun it pins.
  assert.ok(engine.packages.cli);
});

const protocolV1 = {
  version: 1,
  protocol: { min: 1, max: 1, features: [] },
};
const protocolV2 = {
  version: 2,
  protocol: { min: 2, max: 2, features: ["runtime-tenants"] },
};

test("D1: protocol parse and equality helpers", () => {
  const parsed = parseProtocolConstants(`
export const PROTOCOL_VERSION = 2;
export const PROTOCOL_FEATURES = ["runtime-tenants"] as const;
export const HOST_PROTOCOL: ProtocolRange = {
  min: 2,
  max: 2,
  features: PROTOCOL_FEATURES,
};
`);
  assert.deepEqual(parsed, protocolV2);
  assert.equal(protocolEquals(protocolV2, protocolV2), true);
  assert.equal(protocolEquals(protocolV1, protocolV2), false);
  assert.equal(isBreakingBump("minor", "0.4.0-beta"), true);
  assert.equal(isBreakingBump("patch", "0.4.0-beta"), false);
  assert.equal(isBreakingBump("major", "1.0.0"), true);
  assert.equal(isBreakingBump("minor", "1.0.0"), false);
});

test("D1: protocol change without breaking bumps for core/runtime/agents/nylorun fails", () => {
  assert.throws(
    () =>
      planVersions(versions, pins, [intent("harness", "minor")], {
        currentProtocol: protocolV2,
        releasedProtocol: protocolV1,
      }),
    /PROTOCOL_VERSION or HOST_PROTOCOL changed.*core, runtime, agents, nylorun/,
  );
});

test("D1: protocol change with only patch intent fails", () => {
  assert.throws(
    () =>
      planVersions(
        versions,
        pins,
        [
          intent("core", "patch"),
          intent("runtime", "patch"),
          intent("agents", "patch"),
          intent("nylorun", "patch"),
        ],
        { currentProtocol: protocolV2, releasedProtocol: protocolV1 },
      ),
    /breaking bump/,
  );
});

test("D1: protocol change with pre-1.0 minor bumps for core/runtime/agents/nylorun passes", () => {
  const { plan } = planVersions(
    versions,
    pins,
    [
      intent("core", "minor"),
      intent("runtime", "minor"),
      intent("agents", "minor"),
      intent("nylorun", "minor"),
    ],
    { currentProtocol: protocolV2, releasedProtocol: protocolV1 },
  );
  assert.equal(plan.packages.core, "0.2.0-beta");
  assert.equal(plan.packages.runtime, "0.2.0-beta");
  assert.equal(plan.packages.agents, "0.2.0-beta");
  assert.equal(plan.packages.nylorun, "0.2.0-beta");
});

test("D1: protocol change after 1.0 requires major bumps", () => {
  const stable = {
    core: "1.0.0",
    cli: "1.0.0",
    harness: "1.0.0",
    agents: "1.0.0",
    admin: "1.0.0",
    runtime: "1.0.0",
    studio: "1.0.0",
    nylorun: "1.0.0",
    "create-agent": "1.0.0",
  };
  const stablePins = {
    core: "1.0.0",
    harness: "1.0.0",
    agents: "1.0.0",
    admin: "1.0.0",
    runtime: "1.0.0",
  };
  assert.throws(
    () =>
      planVersions(
        stable,
        stablePins,
        [
          intent("core", "minor"),
          intent("runtime", "minor"),
          intent("agents", "minor"),
          intent("nylorun", "minor"),
        ],
        { currentProtocol: protocolV2, releasedProtocol: protocolV1 },
      ),
    /breaking bump/,
  );
  const { plan } = planVersions(
    stable,
    stablePins,
    [
      intent("core", "major"),
      intent("runtime", "major"),
      intent("agents", "major"),
      intent("nylorun", "major"),
    ],
    { currentProtocol: protocolV2, releasedProtocol: protocolV1 },
  );
  assert.equal(plan.packages.core, "2.0.0-beta");
});

test("D1: unchanged protocol does not require breaking bumps", () => {
  const { plan } = planVersions(versions, pins, [intent("harness")], {
    currentProtocol: protocolV2,
    releasedProtocol: protocolV2,
  });
  assert.equal(plan.packages.harness, "0.10.1-beta");
  assert.equal(plan.packages.core, undefined);
});
