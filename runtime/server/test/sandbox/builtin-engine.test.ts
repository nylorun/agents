import { describe, expect, it } from "vitest";
import { isBuiltinEngine } from "../../src/harness/image-engine.js";
import { runsBuiltinEngine } from "../../src/sandbox/pods/builtin.js";

const REPO = "asia-south1-docker.pkg.dev/beta/nylorun/bot-worker";
const DIGEST = `${REPO}@sha256:${"a".repeat(64)}`;

describe("an engine the workload image carries (ADR-99)", () => {
  const base = { image: `${REPO}:0.38.0-beta`, imageDigest: DIGEST, listed: [REPO], runtimeVersion: "0.38.0-beta" };

  it("runs only for an image the Tenant lists", () => {
    expect(runsBuiltinEngine({ ...base, engineImage: undefined })).toBe(true);
    expect(runsBuiltinEngine({ ...base, engineImage: undefined, listed: [] })).toBe(false);
    expect(runsBuiltinEngine({ ...base, engineImage: undefined, listed: undefined })).toBe(false);
    expect(runsBuiltinEngine({ ...base, engineImage: undefined, listed: ["ghcr.io/nylorun/dev"] })).toBe(false);
    expect(runsBuiltinEngine({ ...base, image: undefined, imageDigest: undefined, engineImage: undefined })).toBe(false);
    // A listed entry may carry a tag; the repository is what counts.
    expect(runsBuiltinEngine({ ...base, engineImage: undefined, listed: [`${REPO}:0.37.0-beta`] })).toBe(true);
  });

  it("runs while its engine is this Runtime's version, or not known yet for the digest it runs", () => {
    expect(runsBuiltinEngine({ ...base, engineImage: { version: "0.38.0-beta", digest: DIGEST } })).toBe(true);
    expect(runsBuiltinEngine({ ...base, engineImage: { version: "0.37.0-beta", digest: DIGEST } })).toBe(false);
    // Seen on another digest, or before the digest was pinned: not known for this one.
    expect(runsBuiltinEngine({ ...base, engineImage: { version: "0.37.0-beta", digest: `${REPO}@sha256:${"b".repeat(64)}` } })).toBe(true);
    expect(runsBuiltinEngine({ ...base, engineImage: { version: "0.37.0-beta" } })).toBe(true);
    // Not pinned yet: the first start runs the image's engine.
    expect(runsBuiltinEngine({ ...base, imageDigest: undefined, engineImage: { version: "0.37.0-beta" } })).toBe(true);
  });

  it("knows an engine runs from the image by where its code is", () => {
    expect(isBuiltinEngine("file:///opt/nylorun/engine/harness.mjs")).toBe(true);
    expect(isBuiltinEngine("file:///nylo/engine/harness.mjs")).toBe(false);
    expect(isBuiltinEngine("file:///nylo/app/runtime/server/dist/harness/pod.js")).toBe(false);
    expect(isBuiltinEngine("file:///opt/nylorunner/x.mjs")).toBe(false);
  });
});
