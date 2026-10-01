import { describe, expect, it } from "vitest";
import {
  resolveSandbox,
  sandboxConfigErrors,
  SUBJECT_INLINE_MESSAGE,
  withinCeiling,
} from "../../src/sandbox/resolve.js";
import { effectiveSandboxConfig } from "../../src/sandbox/tenant-config.js";

const config = effectiveSandboxConfig({
  limits: {
    network: ["registry.npmjs.org", "api.github.com", "*.example.com"],
    resources: { cpus: 4, memory: "8GiB" },
    defaultResources: { cpus: 1, memory: "1GiB" },
    idle: "10m",
  },
});
const base = { config, actingForSubject: false } as const;

describe("resolveSandbox", () => {
  it("gives no sandbox for false, and for an unset Tenant default", () => {
    expect(resolveSandbox({ ...base, request: false })).toEqual({ kind: "none" });
    expect(resolveSandbox({ ...base, request: undefined })).toEqual({ kind: "none" });
  });

  it("applies the Tenant default when the request omits the sandbox", () => {
    const virtual = effectiveSandboxConfig({ default: "virtual" });
    expect(resolveSandbox({ ...base, config: virtual, request: undefined })).toEqual({
      kind: "sandbox",
      source: "default",
      spec: {
        network: { preset: "none" },
        resources: { cpus: 2, memory: "1024MiB" },
        idle: "15m",
      },
    });
  });

  it("resolves an inline sandbox within the limits, with no egress unless asked", () => {
    const resolved = resolveSandbox({
      ...base,
      request: {
        network: { allow: ["API.github.com", "registry.npmjs.org", "api.github.com"] },
        resources: { cpus: 2 },
      },
    });
    expect(resolved).toEqual({
      kind: "sandbox",
      source: "inline",
      spec: {
        network: { preset: "none", allow: ["api.github.com", "registry.npmjs.org"] },
        resources: { cpus: 2, memory: "1024MiB" },
        idle: "10m",
      },
    });
    expect(resolveSandbox({ ...base, request: {} })).toMatchObject({
      spec: { network: { preset: "none" } },
    });
  });

  it("reports every problem at once", () => {
    const resolved = resolveSandbox({
      ...base,
      request: {
        image: "node:24",
        network: { allow: ["api.openai.com", "*.example.com"] },
        resources: { cpus: 8, memory: "16GiB" },
      },
    });
    expect(resolved).toEqual({
      kind: "error",
      status: 400,
      errors: [
        "sandbox.image is not supported: the virtual sandbox has no images.",
        "sandbox.network.allow includes api.openai.com, which this Tenant does not allow.",
        "sandbox.network.allow includes *.example.com; the virtual sandbox allows exact host names only, such as example.com.",
        "sandbox.resources.cpus asks for 8; this Tenant allows at most 4.",
        "sandbox.resources.memory asks for 16384MiB; this Tenant allows at most 8192MiB.",
      ],
    });
  });

  it("refuses an inline sandbox from a caller acting for a subject, but not the default", () => {
    expect(resolveSandbox({ ...base, actingForSubject: true, request: {} })).toEqual({
      kind: "error",
      status: 403,
      errors: [SUBJECT_INLINE_MESSAGE],
    });
    const virtual = effectiveSandboxConfig({ default: "virtual" });
    expect(
      resolveSandbox({ ...base, config: virtual, actingForSubject: true, request: undefined })
    ).toMatchObject({ kind: "sandbox", source: "default" });
    expect(resolveSandbox({ ...base, actingForSubject: true, request: false })).toEqual({
      kind: "none",
    });
  });
});

describe("withinCeiling", () => {
  it("matches exact names and suffix patterns", () => {
    const ceiling = ["api.github.com", "*.pythonhosted.org"];
    expect(withinCeiling("api.github.com", ceiling)).toBe(true);
    expect(withinCeiling("files.pythonhosted.org", ceiling)).toBe(true);
    expect(withinCeiling("*.a.pythonhosted.org", ceiling)).toBe(true);
    expect(withinCeiling("pythonhosted.org", ceiling)).toBe(false);
    expect(withinCeiling("github.com", ceiling)).toBe(false);
  });
});

describe("sandboxConfigErrors", () => {
  it("rejects a default outside the limits and defaults above the maximum", () => {
    const errors = sandboxConfigErrors(
      effectiveSandboxConfig({
        default: { network: { allow: ["api.openai.com"] } },
        limits: { resources: { cpus: 2 }, defaultResources: { cpus: 3 } },
      })
    );
    expect(errors).toEqual([
      "limits.defaultResources.cpus is above limits.resources.cpus.",
      "default: sandbox.network.allow includes api.openai.com, which this Tenant does not allow.",
      "default: sandbox.resources.cpus asks for 3; this Tenant allows at most 2.",
    ]);
  });
});
