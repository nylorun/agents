import { describe, expect, it } from "vitest";
import {
  parseRole,
  parseStackConfig,
  StackConfigError,
} from "../../src/host/stack-config.js";
import { isAllowedRequestHost } from "../../src/host/http.js";

describe("parseRole", () => {
  it("defaults to all", () => {
    expect(parseRole([])).toBe("all");
  });

  it("accepts --role <value> and --role=<value>", () => {
    expect(parseRole(["--role", "api"])).toBe("api");
    expect(parseRole(["--role=worker"])).toBe("worker");
    expect(parseRole(["--role", "all"])).toBe("all");
  });

  it("rejects unknown roles, missing values, repeats and unknown arguments", () => {
    expect(() => parseRole(["--role", "db"])).toThrow(StackConfigError);
    expect(() => parseRole(["--role"])).toThrow(/requires a value/);
    expect(() => parseRole(["--role", "--x"])).toThrow(/requires a value/);
    expect(() => parseRole(["--role", "api", "--role", "all"])).toThrow(/once/);
    expect(() => parseRole(["--port", "1"])).toThrow(/Unknown argument/);
  });
});

describe("parseStackConfig", () => {
  it("is local mode with no endpoints for the launcher's environment", () => {
    const config = parseStackConfig(
      { NYLORUN_HOME: "/home/u/.nylorun", PATH: "/usr/bin" },
      [],
    );
    expect(config).toEqual({ role: "all", endpoints: {} });
  });

  it("parses the Compose runtime service environment", () => {
    const config = parseStackConfig(
      {
        NYLORUN_HOME: "/nylorun",
        NYLORUN_LISTEN_HOST: "0.0.0.0",
        NYLORUN_LISTEN_PORT: "4000",
        NYLORUN_ALLOWED_HOSTS:
          "runtime:4000, localhost:8787,127.0.0.1:8787 ,",
        NYLORUN_DATABASE_URL: "postgres://nylorun:pw@postgres:5432/nylorun",
        NYLORUN_RESTATE_INGRESS_URL: "http://restate:8080",
        NYLORUN_RESTATE_ADMIN_URL: "http://restate:9070",
        NYLORUN_WORKER_URL: "http://runtime:9080",
        NYLORUN_S2_ENDPOINT: "http://s2:80",
        NYLORUN_S2_TOKEN: "ignored",
        NYLORUN_WORKSPACE_STORE_URL: "file:///workspaces",
      },
      ["--role", "all"],
    );
    expect(config).toEqual({
      role: "all",
      listen: {
        host: "0.0.0.0",
        port: 4000,
        allowedHosts: [
          "runtime:4000",
          "localhost:8787",
          "127.0.0.1:8787",
          "localhost:4000",
          "127.0.0.1:4000",
          "[::1]:4000",
        ],
      },
      endpoints: {
        databaseUrl: "postgres://nylorun:pw@postgres:5432/nylorun",
        restateIngressUrl: "http://restate:8080",
        restateAdminUrl: "http://restate:9070",
        workerUrl: "http://runtime:9080",
        s2Endpoint: "http://s2:80",
        s2Token: "ignored",
        workspaceStoreUrl: "file:///workspaces",
      },
    });
  });

  it("defaults container mode to 0.0.0.0:4000 when only the allowlist is set", () => {
    const config = parseStackConfig(
      { NYLORUN_ALLOWED_HOSTS: "RUNTIME:4000" },
      [],
    );
    expect(config.listen?.host).toBe("0.0.0.0");
    expect(config.listen?.port).toBe(4000);
    expect(config.listen?.allowedHosts).toContain("runtime:4000");
  });

  it("requires an allowlist for a non-loopback listen host", () => {
    expect(() =>
      parseStackConfig({ NYLORUN_LISTEN_HOST: "0.0.0.0" }, []),
    ).toThrow(/NYLORUN_ALLOWED_HOSTS is required/);
    expect(() =>
      parseStackConfig({ NYLORUN_LISTEN_PORT: "4000" }, []),
    ).toThrow(/NYLORUN_ALLOWED_HOSTS is required/);
  });

  it("allows a loopback listen host without an explicit allowlist", () => {
    const config = parseStackConfig(
      { NYLORUN_LISTEN_HOST: "127.0.0.1", NYLORUN_LISTEN_PORT: "4100" },
      [],
    );
    expect(config.listen).toEqual({
      host: "127.0.0.1",
      port: 4100,
      allowedHosts: ["localhost:4100", "127.0.0.1:4100", "[::1]:4100"],
    });
  });

  it("rejects malformed ports and allowlist entries", () => {
    for (const port of ["0", "65536", "80a", "-1"]) {
      expect(() =>
        parseStackConfig(
          { NYLORUN_LISTEN_PORT: port, NYLORUN_ALLOWED_HOSTS: "runtime:4000" },
          [],
        ),
      ).toThrow(/NYLORUN_LISTEN_PORT/);
    }
    for (const entry of ["runtime", "http://runtime:4000", "::1:4000", "a b:1", "runtime:0"]) {
      expect(() =>
        parseStackConfig({ NYLORUN_ALLOWED_HOSTS: entry }, []),
      ).toThrow(/NYLORUN_ALLOWED_HOSTS/);
    }
    expect(
      parseStackConfig({ NYLORUN_ALLOWED_HOSTS: "[::1]:8787" }, []).listen
        ?.allowedHosts[0],
    ).toBe("[::1]:8787");
  });

  it("validates endpoint URLs and names the variable", () => {
    expect(() =>
      parseStackConfig({ NYLORUN_DATABASE_URL: "http://postgres:5432" }, []),
    ).toThrow(/NYLORUN_DATABASE_URL must use postgres or postgresql/);
    expect(() =>
      parseStackConfig({ NYLORUN_RESTATE_INGRESS_URL: "restate:8080x" }, []),
    ).toThrow(/NYLORUN_RESTATE_INGRESS_URL/);
    expect(() =>
      parseStackConfig({ NYLORUN_S2_ENDPOINT: "not a url" }, []),
    ).toThrow(/NYLORUN_S2_ENDPOINT is not a valid URL/);
    expect(
      parseStackConfig({ NYLORUN_DATABASE_URL: "postgresql://x@db/y" }, [])
        .endpoints.databaseUrl,
    ).toBe("postgresql://x@db/y");
  });

  it("treats blank values as unset", () => {
    expect(
      parseStackConfig(
        { NYLORUN_LISTEN_HOST: " ", NYLORUN_DATABASE_URL: "" },
        [],
      ),
    ).toEqual({ role: "all", endpoints: {} });
  });
});

describe("isAllowedRequestHost with an explicit allowlist", () => {
  const allowedHosts = ["runtime:4000", "localhost:8787", "127.0.0.1:8787"];

  it("accepts exactly the listed Host headers, case-insensitively", () => {
    for (const host of ["runtime:4000", "LOCALHOST:8787", "127.0.0.1:8787"]) {
      expect(
        isAllowedRequestHost(host, { port: 4000, host: "0.0.0.0", allowedHosts }),
        host,
      ).toBe(true);
    }
  });

  it("replaces the loopback rule: loopback forms of the listen port need listing", () => {
    for (const host of [
      "localhost:4000",
      "127.0.0.1:4000",
      "0.0.0.0:4000",
      "runtime:8787",
      "evil.example:8787",
      "runtime",
    ]) {
      expect(
        isAllowedRequestHost(host, { port: 4000, host: "0.0.0.0", allowedHosts }),
        host,
      ).toBe(false);
    }
    expect(
      isAllowedRequestHost(undefined, { port: 4000, host: "0.0.0.0", allowedHosts }),
    ).toBe(false);
  });

  it("keeps the loopback rule when no allowlist is given", () => {
    expect(isAllowedRequestHost("localhost:4000", { port: 4000, host: "127.0.0.1" })).toBe(true);
    expect(isAllowedRequestHost("runtime:4000", { port: 4000, host: "127.0.0.1" })).toBe(false);
  });
});
