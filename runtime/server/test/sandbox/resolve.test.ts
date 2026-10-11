/**
 * An Environment's recipe resolved against the Tenant's limits (`resolveRecipe`, protocol 11),
 * and the sandbox spec a recipe gives a session (`sandboxSpecOf`) and a pod (`podSandboxSpecOf`).
 */
import { describe, expect, it } from "vitest";
import {
  podSandboxSpecOf,
  resolveRecipe,
  sandboxConfigErrors,
  sandboxSpecOf,
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

describe("resolveRecipe", () => {
  it("resolves a virtual recipe within the limits, with no egress unless asked", () => {
    expect(
      resolveRecipe(
        "virtual",
        {
          network: { allowedHosts: ["API.github.com", "registry.npmjs.org", "api.github.com"] },
          resources: { cpus: 2 },
        },
        config,
      ),
    ).toEqual({
      kind: "recipe",
      recipe: {
        resources: { cpus: 2, memory: "1024MiB" },
        network: { allowedHosts: ["api.github.com", "registry.npmjs.org"] },
        harness: "nylorun",
        lifecycle: {},
      },
    });
    // Nothing asked: the Tenant's default resources and no hosts.
    expect(resolveRecipe("virtual", {}, config)).toEqual({
      kind: "recipe",
      recipe: {
        resources: { cpus: 1, memory: "1024MiB" },
        network: { allowedHosts: [] },
        harness: "nylorun",
        lifecycle: {},
      },
    });
    // The built-in defaults without Tenant settings.
    expect(resolveRecipe("virtual", {}, effectiveSandboxConfig({}))).toMatchObject({
      recipe: { resources: { cpus: 2, memory: "1024MiB" } },
    });
  });

  it("reports every problem at once", () => {
    expect(
      resolveRecipe(
        "virtual",
        {
          image: "node:24",
          storage: "5GiB",
          network: { allowedHosts: ["api.openai.com", "*.example.com"] },
          resources: { cpus: 8, memory: "16GiB" },
          harness: "codex",
          lifecycle: { idle: "1h" },
        },
        config,
      ),
    ).toEqual({
      kind: "error",
      errors: [
        "harness codex is not available: only nylorun is.",
        "lifecycle.idle is 1h; this Tenant allows at most 10m.",
        "image is for kind pod: a virtual Environment runs no images.",
        "storage is for kind pod: a virtual Environment has no volume.",
        "network.allowedHosts includes api.openai.com, which this Tenant does not allow.",
        "network.allowedHosts includes *.example.com; a virtual Environment allows exact host names only, such as example.com.",
        "resources.cpus asks for 8; this Tenant allows at most 4.",
        "resources.memory asks for 16384MiB; this Tenant allows at most 8192MiB.",
      ],
    });
  });

  it("lets a pod's egress-gate match *.suffix patterns within the Tenant's ceiling, and takes an image and storage", () => {
    expect(
      resolveRecipe(
        "pod",
        {
          image: "node:24",
          storage: "10GiB",
          network: { allowedHosts: ["*.example.com", "api.github.com"] },
          lifecycle: { idle: "5m", deleteAfter: "30d" },
        },
        config,
      ),
    ).toEqual({
      kind: "recipe",
      recipe: {
        image: "node:24",
        resources: { cpus: 1, memory: "1024MiB" },
        storage: "10GiB",
        network: { allowedHosts: ["*.example.com", "api.github.com"] },
        harness: "nylorun",
        lifecycle: { idle: "5m", deleteAfter: "30d" },
      },
    });
    expect(resolveRecipe("pod", { network: { allowedHosts: ["*.github.com"] } }, config)).toEqual({
      kind: "error",
      errors: ["network.allowedHosts includes *.github.com, which this Tenant does not allow."],
    });
  });

  it("gives kind none no sandbox fields: only its harness and lifecycle", () => {
    expect(resolveRecipe("none", { lifecycle: { deleteAfter: "7d" } }, config)).toEqual({
      kind: "recipe",
      recipe: { harness: "nylorun", lifecycle: { deleteAfter: "7d" } },
    });
    expect(
      resolveRecipe(
        "none",
        { image: "node:24", resources: { cpus: 1 }, storage: "1GiB", network: { allowedHosts: [] } },
        config,
      ),
    ).toEqual({
      kind: "error",
      errors: [
        "image is for an Environment with a sandbox: kind none has none.",
        "resources is for an Environment with a sandbox: kind none has none.",
        "storage is for an Environment with a sandbox: kind none has none.",
        "network is for an Environment with a sandbox: kind none has none.",
      ],
    });
  });
});

describe("sandboxSpecOf", () => {
  it("gives the session's sandbox the recipe's hosts, resources and idle, else the Tenant's idle", () => {
    expect(
      sandboxSpecOf(
        {
          resources: { cpus: 2, memory: "1024MiB" },
          network: { allowedHosts: ["api.github.com"] },
          harness: "nylorun",
          lifecycle: {},
        },
        "10m",
      ),
    ).toEqual({
      network: { preset: "none", allow: ["api.github.com"] },
      resources: { cpus: 2, memory: "1024MiB" },
      idle: "10m",
    });
    expect(
      sandboxSpecOf(
        { network: { allowedHosts: [] }, harness: "nylorun", lifecycle: { idle: "2m" } },
        "10m",
      ),
    ).toEqual({ network: { preset: "none" }, idle: "2m" });
  });

  it("gives a pod its image and its volume's size too", () => {
    expect(
      podSandboxSpecOf(
        {
          image: "node:24",
          resources: { cpus: 1, memory: "512MiB" },
          storage: "10GiB",
          network: { allowedHosts: ["*.example.com"] },
          harness: "nylorun",
          lifecycle: {},
        },
        "15m",
      ),
    ).toEqual({
      image: "node:24",
      network: { preset: "none", allow: ["*.example.com"] },
      resources: { cpus: 1, memory: "512MiB" },
      idle: "15m",
      storage: "10GiB",
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
  it("rejects default resources above the maximum", () => {
    expect(
      sandboxConfigErrors(
        effectiveSandboxConfig({
          limits: { resources: { cpus: 2, memory: "1GiB" }, defaultResources: { cpus: 3, memory: "2GiB" } },
        })
      )
    ).toEqual([
      "limits.defaultResources.cpus is above limits.resources.cpus.",
      "limits.defaultResources.memory is above limits.resources.memory.",
    ]);
    expect(sandboxConfigErrors(effectiveSandboxConfig({}))).toEqual([]);
  });
});
