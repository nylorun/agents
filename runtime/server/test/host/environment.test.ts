import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { hostPaths, tenantPaths } from "../../src/tenant/paths.js";
import {
  baselineEnvironment,
  hostProcessEnvironment,
} from "../../src/host/environment.js";
import type { HostConfigFile } from "../../src/host/config.js";
import { configForFactory } from "../../src/host/config-for.js";
import { createHostLogger } from "../../src/host/logger.js";

it("C7: baselineEnvironment allowlists PATH, LANG, LC_*, TZ and drops NODE_OPTIONS", () => {
  const env = baselineEnvironment({
    PATH: "/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
    NODE_OPTIONS: "--require ./evil.js",
    HOME: "/wrong",
    OPENAI_API_KEY: "sk-secret",
    NYLORUN_VAULT_KEK: "kek",
  });
  expect(env).toEqual({
    PATH: "/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
  });
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(env).not.toHaveProperty("HOME");
});

it("C7: hostProcessEnvironment sets Host HOME/TMPDIR and proxy, never NODE_OPTIONS", () => {
  const root = "/tmp/host-root";
  const paths = hostPaths(root);
  const config: HostConfigFile = {
    hostId: "host_0123456789abcdefghjkmnpq",
    host: "127.0.0.1",
    port: 8787,
    proxy: {
      httpsProxy: "http://proxy:8080",
      noProxy: "localhost",
      nodeExtraCaCerts: "/certs/ca.pem",
    },
  };
  const env = hostProcessEnvironment(
    { PATH: "/bin", LANG: "C" },
    config,
    paths,
  );
  expect(env.HOME).toBe(paths.home);
  expect(env.TMPDIR).toBe(paths.tmp);
  expect(env.NYLORUN_HOME).toBe(paths.root);
  expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
  expect(env.NO_PROXY).toBe("localhost");
  expect(env.NODE_EXTRA_CA_CERTS).toBe("/certs/ca.pem");
  expect(env.PATH).toBe("/bin");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
});

it("C8: configFor stub returns defaults in the Tenant directory", () => {
  const realRoot = mkdtempSync(join(tmpdir(), "cfg-"));
  try {
    const id = newTenantId();
    const forId = configForFactory({
      hostRoot: realRoot,
      logger: createHostLogger(() => {}),
    });
    const tenantConfig = forId(id);
    expect(tenantConfig.tenantId).toBe(id);
    expect(tenantConfig.mode).toBe("shared");
    expect(tenantConfig.model).toEqual({ kind: "vault" });
    expect(tenantConfig.sandbox.backend).toBe("auto");
    expect(tenantConfig.paths.home).toBe(tenantPaths(realRoot).home);
  } finally {
    rmSync(realRoot, { recursive: true, force: true });
  }
});
