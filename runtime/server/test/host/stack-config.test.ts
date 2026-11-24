import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58btc } from "../../src/host/restate-identity.js";
import {
  parseServices,
  parseStackConfig,
  parseTraceContent,
  StackConfigError,
} from "../../src/host/stack-config.js";
import { isAllowedRequestHost } from "../../src/host/http.js";

describe("parseServices", () => {
  const services = (...names: string[]) => new Set(names);

  it("defaults to core and loop", () => {
    expect(parseServices([])).toEqual({ services: services("core", "loop") });
  });

  it("accepts --service <list> and --service=<list>", () => {
    expect(parseServices(["--service", "core,loop"])).toEqual({
      services: services("core", "loop"),
    });
    expect(parseServices(["--service=loop"])).toEqual({ services: services("loop") });
    expect(parseServices(["--service", " core "])).toEqual({ services: services("core") });
  });

  it("maps the deprecated --role to services", () => {
    expect(parseServices(["--role", "api"])).toEqual({
      services: services("core"),
      deprecatedRole: "api",
    });
    expect(parseServices(["--role=worker"])).toEqual({
      services: services("loop"),
      deprecatedRole: "worker",
    });
    expect(parseServices(["--role", "all"])).toEqual({
      services: services("core", "loop"),
      deprecatedRole: "all",
    });
  });

  it("runs keys with gates, and never with core or loop", () => {
    expect(parseServices(["--service", "gates,keys"])).toEqual({ services: services("gates", "keys") });
    expect(() => parseServices(["--service", "core,keys"])).toThrow(/may not share a process/);
  });

  it("runs egress with gates and keys, and never with core or loop", () => {
    expect(parseServices(["--service", "gates,keys,egress"])).toEqual({
      services: services("gates", "keys", "egress"),
    });
    expect(parseServices(["--service", "egress"])).toEqual({ services: services("egress") });
    expect(() => parseServices(["--service", "core,egress"])).toThrow(/may not share a process/);
  });

  it("parses egress-gate's listener, by default 0.0.0.0:4200", () => {
    const gateway = { NYLORUN_GATES_TOKEN: "a".repeat(64), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" };
    expect(parseStackConfig(gateway, ["--service", "gates,keys,egress"]).egress).toEqual({
      listen: { host: "0.0.0.0", port: 4200 },
    });
    expect(parseStackConfig(gateway, ["--service", "gates,keys"]).egress).toBeUndefined();
    expect(
      parseStackConfig({ NYLORUN_EGRESS_LISTEN_HOST: "127.0.0.1", NYLORUN_EGRESS_LISTEN_PORT: "4299" }, [
        "--service",
        "egress",
      ]),
    ).toMatchObject({ egress: { listen: { host: "127.0.0.1", port: 4299 } } });
    expect(() =>
      parseStackConfig({ NYLORUN_EGRESS_LISTEN_PORT: "http" }, ["--service", "egress"]),
    ).toThrow(/NYLORUN_EGRESS_LISTEN_PORT must be a port number/);
  });

  it("reads the keys service's URL, defaulting to the gateway's", () => {
    const token = "ab".repeat(32);
    expect(
      parseStackConfig({ NYLORUN_GATES_URL: "http://gateway:4100", NYLORUN_GATES_TOKEN: token }, []).keys,
    ).toEqual({ url: "http://gateway:4100", token });
    expect(
      parseStackConfig(
        { NYLORUN_GATES_URL: "http://gateway:4100", NYLORUN_KEYS_URL: "http://keys:4200/", NYLORUN_GATES_TOKEN: token },
        [],
      ).keys,
    ).toEqual({ url: "http://keys:4200", token });
    expect(() => parseStackConfig({ NYLORUN_WORKER_VERSION: "1.0/../admin" }, [])).toThrow(
      /NYLORUN_WORKER_VERSION must be 1 to 64 letters/,
    );
    expect(() => parseStackConfig({ NYLORUN_KEYS_URL: "http://keys:4200" }, [])).toThrow(
      /NYLORUN_GATES_TOKEN is required with NYLORUN_KEYS_URL/,
    );
  });

  it("runs gates alone: never in a process with core or loop", () => {
    expect(parseServices(["--service", "gates"])).toEqual({ services: services("gates") });
    expect(() => parseServices(["--service", "core,gates"])).toThrow(
      /core and loop may not share a process with gates/,
    );
    expect(() => parseServices(["--service", "loop,gates"])).toThrow(/separate processes/);
  });

  it("rejects unknown, later, empty and repeated services", () => {
    expect(() => parseServices(["--service", "db"])).toThrow(/Unknown service db/);
    expect(() => parseServices(["--service", "all"])).toThrow(/use --service core,loop/);
    expect(() => parseServices(["--service", "sandboxes"])).toThrow(/not in this release/);
    expect(() => parseServices(["--service", "core,,loop"])).toThrow(/empty entry/);
    expect(() => parseServices(["--service", "core,core"])).toThrow(/twice/);
  });

  it("rejects missing values, repeats, both flags and unknown arguments", () => {
    expect(() => parseServices(["--role", "db"])).toThrow(StackConfigError);
    expect(() => parseServices(["--role"])).toThrow(/requires a value/);
    expect(() => parseServices(["--service"])).toThrow(/requires a value/);
    expect(() => parseServices(["--service", "--x"])).toThrow(/requires a value/);
    expect(() => parseServices(["--role", "api", "--role", "all"])).toThrow(/once/);
    expect(() => parseServices(["--service", "core", "--service", "loop"])).toThrow(/once/);
    expect(() => parseServices(["--service", "core", "--role", "api"])).toThrow(
      /only --service/,
    );
    expect(() => parseServices(["--port", "1"])).toThrow(/Unknown argument/);
    expect(() => parseServices(["--services=core"])).toThrow(/Unknown argument/);
  });
});

/** The default telemetry of a process: `/metrics` on port 9464, no OTLP. */
function telemetryOf(serviceName: string, host: string) {
  return { resource: { serviceName, attributes: {} }, metrics: { prometheus: { host, port: 9464 } } };
}

/** A process that runs only core: it serves the API listener and needs no gate. */
const CORE = ["--service", "core"];

describe("parseStackConfig", () => {
  it("is local mode with no endpoints for a bare environment", () => {
    const config = parseStackConfig(
      { NYLORUN_HOME: "/home/u/.nylorun", PATH: "/usr/bin" },
      [],
    );
    expect(config).toEqual({
      services: new Set(["core", "loop"]),
      endpoints: {},
      tenant: { name: "default" },
      // A local Host serves /metrics on loopback.
      telemetry: telemetryOf("nylorun-runtime", "127.0.0.1"),
    });
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
        NYLORUN_WORKER_VERSION: "0.22.0-rc.1",
        NYLORUN_S2_ENDPOINT: "http://s2:80",
        NYLORUN_S2_TOKEN: "ignored",
        NYLORUN_WORKSPACE_STORE_URL: "file:///workspaces",
        NYLORUN_GATES_URL: "http://gateway:4100",
        NYLORUN_KEYS_URL: "http://gateway:4100",
        NYLORUN_GATES_TOKEN: "ab".repeat(32),
        NYLORUN_PACKING: "combined",
      },
      ["--service", "core,loop"],
    );
    expect(config).toEqual({
      services: new Set(["core", "loop"]),
      modelGate: { url: "http://gateway:4100", token: "ab".repeat(32) },
      keys: { url: "http://gateway:4100", token: "ab".repeat(32) },
      packing: "combined",
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
        workerVersion: "0.22.0-rc.1",
        s2Endpoint: "http://s2:80",
        s2Token: "ignored",
        workspaceStoreUrl: "file:///workspaces",
      },
      tenant: { name: "default" },
      telemetry: telemetryOf("nylorun-runtime", "0.0.0.0"),
    });
  });

  it("defaults container mode to 0.0.0.0:4000 when only the allowlist is set", () => {
    const config = parseStackConfig(
      { NYLORUN_ALLOWED_HOSTS: "RUNTIME:4000" },
      CORE,
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
      CORE,
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
          CORE,
        ),
      ).toThrow(/NYLORUN_LISTEN_PORT/);
    }
    for (const entry of ["runtime", "http://runtime:4000", "::1:4000", "a b:1", "runtime:0"]) {
      expect(() =>
        parseStackConfig({ NYLORUN_ALLOWED_HOSTS: entry }, CORE),
      ).toThrow(/NYLORUN_ALLOWED_HOSTS/);
    }
    expect(
      parseStackConfig({ NYLORUN_ALLOWED_HOSTS: "[::1]:8787" }, CORE).listen
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

  it("parses the public URL and Restate identity keys", () => {
    const key = "publickeyv1_CgojDdtCBsK8zYsbqruLmwXgWqMYxDfu3n5qJdcJeNtv";
    const config = parseStackConfig(
      {
        NYLORUN_PUBLIC_URL: "http://localhost:8787/",
        NYLORUN_RESTATE_IDENTITY_KEY: `${key}, ${key.replace("C", "D")} ,`,
      },
      [],
    );
    expect(config.publicUrl).toBe("http://localhost:8787");
    expect(config.endpoints.restateIdentityKeys).toEqual([
      key,
      key.replace("C", "D"),
    ]);
    expect(() =>
      parseStackConfig({ NYLORUN_PUBLIC_URL: "localhost:8787" }, []),
    ).toThrow(/NYLORUN_PUBLIC_URL must use http or https/);
    for (const bad of ["publickeyv1_0OIl", "CgojDdtCBsK8zYsbqruLmwXgWqMYxDfu3n5qJdcJeNtv", "publickeyv1_"])
      expect(() =>
        parseStackConfig({ NYLORUN_RESTATE_IDENTITY_KEY: bad }, []),
      ).toThrow(/NYLORUN_RESTATE_IDENTITY_KEY must be publickeyv1_/);
  });

  it("computes a Restate identity key from NYLORUN_RESTATE_IDENTITY_KEY_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "nylorun-identity-"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = join(dir, "private.pem");
    const publicPem = join(dir, "public.pem");
    writeFileSync(privatePem, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    writeFileSync(publicPem, publicKey.export({ format: "pem", type: "spki" }).toString());
    const fromPrivate = parseStackConfig({ NYLORUN_RESTATE_IDENTITY_KEY_FILE: privatePem }, []).endpoints.restateIdentityKeys;
    const fromPublic = parseStackConfig({ NYLORUN_RESTATE_IDENTITY_KEY_FILE: publicPem }, []).endpoints.restateIdentityKeys;
    expect(fromPrivate).toHaveLength(1);
    expect(fromPrivate![0]).toMatch(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{32,64}$/);
    expect(fromPublic).toEqual(fromPrivate);
    const rsa = join(dir, "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    expect(() => parseStackConfig({ NYLORUN_RESTATE_IDENTITY_KEY_FILE: rsa }, [])).toThrow(
      /NYLORUN_RESTATE_IDENTITY_KEY_FILE .* is not an Ed25519 PEM/,
    );
  });

  it("encodes a known key as Restate does", () => {
    // 32 bytes: one leading zero, then 1..31.
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(base58btc(raw).startsWith("1")).toBe(true);
    expect(base58btc(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(base58btc(Uint8Array.from([255]))).toBe("5Q");
  });

  it("treats blank values as unset", () => {
    expect(
      parseStackConfig(
        {
          NYLORUN_LISTEN_HOST: " ",
          NYLORUN_DATABASE_URL: "",
          NYLORUN_PUBLIC_URL: "",
          NYLORUN_RESTATE_IDENTITY_KEY: " , ",
        },
        [],
      ),
    ).toEqual({
      services: new Set(["core", "loop"]),
      endpoints: {},
      tenant: { name: "default" },
      telemetry: telemetryOf("nylorun-runtime", "127.0.0.1"),
    });
  });
});

describe("parseStackConfig for --service gates", () => {
  const token = "ab".repeat(32);
  const gateway = {
    // The image sets these for the API; a gates process ignores them.
    NYLORUN_LISTEN_HOST: "0.0.0.0",
    NYLORUN_LISTEN_PORT: "4000",
    NYLORUN_DATABASE_URL: "postgres://nylorun:pw@postgres:5432/nylorun",
    NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100",
    NYLORUN_GATES_TOKEN: token,
  };

  it("parses the gate's listener and token, and no API listener", () => {
    expect(parseStackConfig(gateway, ["--service", "gates"])).toEqual({
      services: new Set(["gates"]),
      gates: {
        listen: {
          host: "0.0.0.0",
          port: 4100,
          allowedHosts: ["gateway:4100", "localhost:4100", "127.0.0.1:4100", "[::1]:4100"],
        },
        token,
      },
      endpoints: { databaseUrl: "postgres://nylorun:pw@postgres:5432/nylorun" },
      telemetry: telemetryOf("nylorun-gateway", "0.0.0.0"),
    });
  });

  it("requires a token of at least 32 bytes as hex, and Host values off loopback", () => {
    const without = (name: string) => ({ ...gateway, [name]: undefined });
    expect(() => parseStackConfig(without("NYLORUN_GATES_TOKEN"), ["--service", "gates"])).toThrow(
      /NYLORUN_GATES_TOKEN is required/,
    );
    expect(() =>
      parseStackConfig({ ...gateway, NYLORUN_GATES_TOKEN: "short" }, ["--service", "gates"]),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      parseStackConfig(without("NYLORUN_GATES_ALLOWED_HOSTS"), ["--service", "gates"]),
    ).toThrow(/NYLORUN_GATES_ALLOWED_HOSTS is required/);
    expect(
      parseStackConfig(
        { ...without("NYLORUN_GATES_ALLOWED_HOSTS"), NYLORUN_GATES_LISTEN_HOST: "127.0.0.1", NYLORUN_GATES_LISTEN_PORT: "4555" },
        ["--service", "gates"],
      ).gates?.listen,
    ).toEqual({
      host: "127.0.0.1",
      port: 4555,
      allowedHosts: ["localhost:4555", "127.0.0.1:4555", "[::1]:4555"],
    });
  });

  it("leaves the gate's listener to gates processes", () => {
    expect(
      parseStackConfig({ NYLORUN_GATES_LISTEN_HOST: "bad host" }, ["--service", "core,loop"]).gates,
    ).toBeUndefined();
  });

  it("names the removed credential resolver's variables instead of failing, and treats empty as unset", () => {
    // Protocol 10: the Host logs `resolver_removed` and ignores them, on any service.
    const resolver = { NYLORUN_RESOLVER_TOKEN: "resolver-token", NYLORUN_RESOLVER_TIMEOUT: "5" };
    const config = parseStackConfig({ ...gateway, ...resolver }, ["--service", "gates,keys"]);
    expect(config.removedResolverVariables).toEqual(["NYLORUN_RESOLVER_TIMEOUT", "NYLORUN_RESOLVER_TOKEN"]);
    expect(config.gates).not.toHaveProperty("resolver");
    expect(parseStackConfig({ ...resolver }, ["--service", "core,loop"]).removedResolverVariables).toHaveLength(2);
    // Compose's `${NYLORUN_RESOLVER_TOKEN:-}` passes empty strings when unset.
    expect(
      parseStackConfig({ ...gateway, NYLORUN_RESOLVER_TOKEN: "" }, ["--service", "gates"]),
    ).not.toHaveProperty("removedResolverVariables");
  });
});

describe("parseStackConfig: where the loop reaches the gate", () => {
  const token = "ab".repeat(32);

  it("reads NYLORUN_GATES_URL and the token for a process that runs loop or core", () => {
    expect(
      parseStackConfig(
        { NYLORUN_GATES_URL: "http://gateway:4100/", NYLORUN_GATES_TOKEN: token },
        ["--service", "core,loop"],
      ).modelGate,
    ).toEqual({ url: "http://gateway:4100", token });
    // core reaches the Tool Gate too: it closes MCP connections outside a run.
    expect(
      parseStackConfig({ NYLORUN_GATES_URL: "http://gateway:4100", NYLORUN_GATES_TOKEN: token }, [
        "--service",
        "core",
      ]).modelGate,
    ).toEqual({ url: "http://gateway:4100", token });
  });

  it("is required for loop in a container, and only for loop", () => {
    const container = { NYLORUN_LISTEN_HOST: "127.0.0.1" };
    expect(() => parseStackConfig(container, ["--service", "core,loop"])).toThrow(
      /NYLORUN_GATES_URL is required for the loop service in a container/,
    );
    expect(() => parseStackConfig(container, ["--service", "loop"])).toThrow(/gateway container/);
    expect(parseStackConfig(container, ["--service", "core"]).modelGate).toBeUndefined();
    // Outside a container (a development Host, tests) the loop may call the model itself.
    expect(parseStackConfig({}, ["--service", "core,loop"]).modelGate).toBeUndefined();
    expect(() => parseStackConfig({ NYLORUN_PACKING: "huge" }, [])).toThrow(/combined or split/);
  });

  it("requires the token with the URL, and the URL with the token", () => {
    expect(() =>
      parseStackConfig({ NYLORUN_GATES_URL: "http://gateway:4100" }, []),
    ).toThrow(/NYLORUN_GATES_TOKEN is required with NYLORUN_GATES_URL/);
    expect(() => parseStackConfig({ NYLORUN_GATES_TOKEN: token }, [])).toThrow(
      /without NYLORUN_GATES_URL/,
    );
    expect(() =>
      parseStackConfig({ NYLORUN_GATES_URL: "ftp://gateway", NYLORUN_GATES_TOKEN: token }, []),
    ).toThrow(/NYLORUN_GATES_URL must use http or https/);
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

  it("matches a Host with no port to its scheme's default port", () => {
    const fronted = [...allowedHosts, "runtime.example.dev:443", "plain.example.dev:80"];
    for (const host of ["runtime.example.dev", "RUNTIME.example.dev", "plain.example.dev", "runtime.example.dev:443"]) {
      expect(isAllowedRequestHost(host, { port: 4000, host: "0.0.0.0", allowedHosts: fronted }), host).toBe(true);
    }
    for (const host of ["runtime", "runtime.example.dev:80", "other.example.dev", "runtime.example.dev:4000"]) {
      expect(isAllowedRequestHost(host, { port: 4000, host: "0.0.0.0", allowedHosts: fronted }), host).toBe(false);
    }
  });

  it("keeps the loopback rule when no allowlist is given", () => {
    expect(isAllowedRequestHost("localhost:4000", { port: 4000, host: "127.0.0.1" })).toBe(true);
    expect(isAllowedRequestHost("runtime:4000", { port: 4000, host: "127.0.0.1" })).toBe(false);
  });
});

describe("NYLORUN_BROWSER_ACCESS (protocol 7)", () => {
  it("is gone: browsers need no toggle, and an old value changes nothing", () => {
    for (const value of ["on", "off", "yes"])
      expect(parseStackConfig({ NYLORUN_BROWSER_ACCESS: value }, [])).not.toHaveProperty("browserAccess");
  });
});

const HARNESS_TOKEN = "ab".repeat(32);

describe("NYLORUN_HARNESS", () => {
  it("runs the harness in process by default", () => {
    expect(parseStackConfig({}, []).harnessMode).toBeUndefined();
    expect(parseStackConfig({ NYLORUN_HARNESS: "in-process" }, [])).toMatchObject({ harnessMode: "in-process" });
    expect(parseStackConfig({}, []).harnessListener).toBeUndefined();
    expect(() => parseStackConfig({ NYLORUN_HARNESS: "elsewhere" }, [])).toThrow(StackConfigError);
  });

  it("starts the Harness API listener for remote harnesses, with its own credential", () => {
    const stack = parseStackConfig(
      {
        NYLORUN_HARNESS: "remote",
        NYLORUN_HARNESS_TOKEN: HARNESS_TOKEN,
        NYLORUN_HARNESS_ALLOWED_HOSTS: "runtime:4200",
      },
      []
    );
    expect(stack.harnessListener).toEqual({
      listen: {
        host: "0.0.0.0",
        port: 4200,
        allowedHosts: ["runtime:4200", "localhost:4200", "127.0.0.1:4200", "[::1]:4200"],
      },
      token: HARNESS_TOKEN,
    });
    expect(() => parseStackConfig({ NYLORUN_HARNESS: "remote", NYLORUN_HARNESS_ALLOWED_HOSTS: "runtime:4200" }, [])).toThrow(
      /NYLORUN_HARNESS_TOKEN is required/
    );
    expect(() => parseStackConfig({ NYLORUN_HARNESS: "remote", NYLORUN_HARNESS_TOKEN: HARNESS_TOKEN }, [])).toThrow(
      /NYLORUN_HARNESS_ALLOWED_HOSTS is required/
    );
    expect(() =>
      parseStackConfig(
        { NYLORUN_HARNESS: "remote", NYLORUN_HARNESS_TOKEN: "short", NYLORUN_HARNESS_LISTEN_HOST: "127.0.0.1" },
        []
      )
    ).toThrow(/at least 32 bytes/);
  });
});

describe("--service harness", () => {
  const base = {
    NYLORUN_HARNESS_URL: "ws://runtime:4200/nylorun/harness/v1",
    NYLORUN_HARNESS_TOKEN: HARNESS_TOKEN,
    NYLORUN_GATES_URL: "http://gateway:4100",
  };

  it("runs alone, and reads where core and the gates are", () => {
    expect(parseStackConfig(base, ["--service", "harness"]).harness).toEqual({
      url: base.NYLORUN_HARNESS_URL,
      token: HARNESS_TOKEN,
      gatesUrl: "http://gateway:4100",
      root: "/harness",
      healthPort: 4300,
    });
    expect(() => parseServices(["--service", "harness,core"])).toThrow(/may not share a process/);
    expect(() => parseServices(["--service", "harness,gates"])).toThrow(/may not share a process/);
  });

  it.each([
    ["NYLORUN_DATABASE_URL", "postgres://postgres@postgres:5432/nylorun"],
    ["NYLORUN_GATES_TOKEN", "cd".repeat(32)],
    ["NYLORUN_KEYS_URL", "http://gateway:4100"],
    ["NYLORUN_RESTATE_INGRESS_URL", "http://restate:8080"],
    ["NYLORUN_RESTATE_ADMIN_URL", "http://restate:9070"],
  ])("refuses to start with %s set", (name, value) => {
    expect(() => parseStackConfig({ ...base, [name]: value }, ["--service", "harness"])).toThrow(
      new RegExp(`refuses to start with ${name}`)
    );
  });

  it("requires its URL, token and the gates", () => {
    for (const name of ["NYLORUN_HARNESS_URL", "NYLORUN_HARNESS_TOKEN", "NYLORUN_GATES_URL"]) {
      const env: Record<string, string> = { ...base };
      delete env[name];
      expect(() => parseStackConfig(env, ["--service", "harness"])).toThrow(new RegExp(`${name} is required`));
    }
    expect(() =>
      parseStackConfig({ ...base, NYLORUN_HARNESS_URL: "http://runtime:4200" }, ["--service", "harness"])
    ).toThrow(/NYLORUN_HARNESS_URL must use ws or wss/);
  });
});

describe("sandbox pods", () => {
  const pod = {
    NYLORUN_SANDBOX_KIND: "pod",
    NYLORUN_HARNESS_URL: "http://192.168.65.254:47321",
    NYLORUN_GATES_URL: "http://192.168.65.254:47322",
    NYLORUN_EGRESS_PROXY: "http://192.168.65.254:47323",
    NYLORUN_SANDBOX_ID: "team/a",
    NYLORUN_POD_UID: "9b2f6c1e-0000-4000-8000-000000000001",
    NYLORUN_SANDBOX_JOIN_FILE: "/run/nylorun/join/token",
  };

  it("marks an Agent Substrate actor's engine, which stays up on SIGTERM (suspend before drain)", () => {
    expect(parseStackConfig(pod, ["--service", "harness"]).harness?.pod?.substrate).toBeUndefined();
    expect(
      parseStackConfig({ ...pod, NYLORUN_SANDBOX_SUBSTRATE: "1" }, ["--service", "harness"]).harness?.pod?.substrate,
    ).toBe(true);
  });

  it("runs a pod's engine without a harness token: it joins with its join file", () => {
    expect(parseStackConfig(pod, ["--service", "harness"]).harness).toEqual({
      url: "ws://192.168.65.254:47321/nylorun/harness/v1",
      pod: {
        sandboxId: "team/a",
        podUid: pod.NYLORUN_POD_UID,
        joinFile: "/run/nylorun/join/token",
        httpUrl: "http://192.168.65.254:47321",
        egressProxy: "http://192.168.65.254:47323",
        blocked: [{ host: "10.96.0.1", port: 443 }],
      },
      gatesUrl: "http://192.168.65.254:47322",
      root: "/harness",
      healthPort: 4300,
    });
    expect(() =>
      parseStackConfig({ ...pod, NYLORUN_HARNESS_TOKEN: HARNESS_TOKEN }, ["--service", "harness"]),
    ).toThrow(/holds no NYLORUN_HARNESS_TOKEN/);
    const { NYLORUN_POD_UID: _uid, ...missing } = pod;
    expect(() => parseStackConfig(missing, ["--service", "harness"])).toThrow(/NYLORUN_POD_UID is required/);
  });

  it("starts the Harness API listener for pods, with or without a harness token", () => {
    const stack = parseStackConfig(
      {
        NYLORUN_SANDBOXES_URL: "http://sandboxes:4300",
        NYLORUN_SANDBOXES_TOKEN: "ef".repeat(32),
        NYLORUN_SANDBOX_HARNESS_IMAGE: "ghcr.io/nylorun/runtime:0.15.2",
        NYLORUN_HARNESS_LISTEN_HOST: "0.0.0.0",
        NYLORUN_HARNESS_LISTEN_PORT: "4200",
        NYLORUN_HARNESS_ALLOWED_HOSTS: "192.168.65.254:47321",
      },
      [],
    );
    expect(stack.sandboxes).toEqual({
      url: "http://sandboxes:4300",
      token: "ef".repeat(32),
      harnessImage: "ghcr.io/nylorun/runtime:0.15.2",
    });
    expect(stack.harnessMode).toBeUndefined();
    expect(stack.harnessListener?.token).toBeUndefined();
    expect(stack.harnessListener?.listen.allowedHosts).toContain("192.168.65.254:47321");
    expect(() =>
      parseStackConfig({ NYLORUN_SANDBOXES_URL: "http://sandboxes:4300", NYLORUN_SANDBOXES_TOKEN: "ef".repeat(32) }, []),
    ).toThrow(/NYLORUN_SANDBOX_HARNESS_IMAGE is required/);
  });

  it("reaches computers through the sandbox gateway with a ticket key", () => {
    const base = {
      NYLORUN_SANDBOXES_URL: "http://sandboxes:4300",
      NYLORUN_SANDBOXES_TOKEN: "ef".repeat(32),
      NYLORUN_SANDBOX_HARNESS_IMAGE: "ghcr.io/nylorun/runtime:0.53.0",
      NYLORUN_HARNESS_LISTEN_HOST: "0.0.0.0",
      NYLORUN_HARNESS_ALLOWED_HOSTS: "runtime:4200",
    };
    const stack = parseStackConfig(
      { ...base, NYLORUN_SANDBOX_GATEWAY_URL: "http://sandbox-gateway:4400/", NYLORUN_COMPUTER_TICKET_KEY_FILE: "/run/nylorun/computer/ticket.key" },
      [],
    );
    expect(stack.sandboxes?.computer).toEqual({
      gatewayUrl: "http://sandbox-gateway:4400",
      ticketKeyFile: "/run/nylorun/computer/ticket.key",
    });
    expect(() => parseStackConfig({ ...base, NYLORUN_SANDBOX_GATEWAY_URL: "http://sandbox-gateway:4400" }, [])).toThrow(
      /go together/,
    );
  });
});

describe("--service computer", () => {
  const computer = {
    NYLORUN_COMPUTER_TICKET_KEY: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n",
    NYLORUN_COMPUTER_NAME_FILE: "/run/nylorun/actor/actor-name",
    NYLORUN_SANDBOX_SUBSTRATE: "1",
  };

  it("runs alone, with its port, key and name file", () => {
    const stack = parseStackConfig(computer, ["--service", "computer"]);
    expect(stack.computer).toEqual({
      port: 8080,
      ticketKey: computer.NYLORUN_COMPUTER_TICKET_KEY.trim(),
      nameFile: "/run/nylorun/actor/actor-name",
      root: "/harness",
      substrate: true,
    });
    expect(() => parseServices(["--service", "computer,harness"])).toThrow(StackConfigError);
  });

  it("refuses a Runtime credential and needs its key", () => {
    expect(() => parseStackConfig({ ...computer, NYLORUN_HARNESS_TOKEN: "x".repeat(40) }, ["--service", "computer"])).toThrow(
      /holds no Runtime credential/,
    );
    const { NYLORUN_COMPUTER_TICKET_KEY: _key, ...keyless } = computer;
    expect(() => parseStackConfig(keyless, ["--service", "computer"])).toThrow(/NYLORUN_COMPUTER_TICKET_KEY is required/);
  });
});

describe("NYLORUN_ADMIN_LISTEN_*", () => {
  it("is not read: the operator listener is gone (protocol 8)", () => {
    const config = parseStackConfig(
      {
        NYLORUN_LISTEN_HOST: "0.0.0.0",
        NYLORUN_LISTEN_PORT: "4000",
        NYLORUN_ALLOWED_HOSTS: "runtime:4000",
        NYLORUN_ADMIN_LISTEN_PORT: "4000",
        NYLORUN_ADMIN_ALLOWED_HOSTS: "runtime:4000",
      },
      CORE
    );
    expect(config).not.toHaveProperty("operator");
    expect(config.listen?.port).toBe(4000);
  });
});

describe("NYLORUN_ENDPOINT_*", () => {
  it("is absent by default and carries each setting when set", () => {
    expect(parseStackConfig({}, []).delivery).toBeUndefined();
    expect(
      parseStackConfig(
        {
          NYLORUN_ENDPOINT_LOOPBACK: "docker-host",
          NYLORUN_ENDPOINT_PRIVATE: "refuse",
          NYLORUN_ENDPOINT_HTTP: "refuse",
        },
        [],
      ).delivery,
    ).toEqual({ loopback: "docker-host", privateAddresses: "refuse", allowHttp: false });
    expect(parseStackConfig({ NYLORUN_ENDPOINT_HTTP: "allow" }, []).delivery).toEqual({ allowHttp: true });
  });

  it("rejects anything else, naming the variable", () => {
    expect(() => parseStackConfig({ NYLORUN_ENDPOINT_LOOPBACK: "host" }, [])).toThrow(/NYLORUN_ENDPOINT_LOOPBACK/);
    expect(() => parseStackConfig({ NYLORUN_ENDPOINT_PRIVATE: "no" }, [])).toThrow(/NYLORUN_ENDPOINT_PRIVATE/);
    expect(() => parseStackConfig({ NYLORUN_ENDPOINT_HTTP: "no" }, [])).toThrow(StackConfigError);
  });
});

describe("the Host's Tenant", () => {
  it("defaults to a new id and the name default", () => {
    expect(parseStackConfig({}, []).tenant).toEqual({ name: "default" });
    // The gates service creates no Tenant.
    const gates = { NYLORUN_GATES_TOKEN: "ab".repeat(32), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" };
    expect(parseStackConfig(gates, ["--service", "gates"]).tenant).toBeUndefined();
  });

  it("reads NYLORUN_TENANT_ID and NYLORUN_TENANT_NAME, and ignores NYLORUN_DERIVED_PRINCIPALS (protocol 7)", () => {
    expect(
      parseStackConfig(
        {
          NYLORUN_TENANT_ID: "tn_0123456789abcdefghjkmnpqrs",
          NYLORUN_TENANT_NAME: "my-app",
          NYLORUN_DERIVED_PRINCIPALS: "project, backend,project",
        },
        [],
      ).tenant,
    ).toEqual({
      id: "tn_0123456789abcdefghjkmnpqrs",
      name: "my-app",
    });
  });

  it("reads NYLORUN_IDENTITY_FILE, and an empty value as none", () => {
    expect(
      parseStackConfig({ NYLORUN_IDENTITY_FILE: " /nylorun/identity.yaml " }, []).tenant?.identityFile,
    ).toBe("/nylorun/identity.yaml");
    expect(parseStackConfig({ NYLORUN_IDENTITY_FILE: "" }, []).tenant).not.toHaveProperty("identityFile");
  });

  it("rejects a malformed Tenant id, naming the variable", () => {
    expect(() => parseStackConfig({ NYLORUN_TENANT_ID: "tn_nope" }, [])).toThrow(/NYLORUN_TENANT_ID/);
  });
});

describe("NYLORUN_CREDENTIAL_PROVIDER_*", () => {
  const provider = {
    NYLORUN_CREDENTIAL_PROVIDER_URL: "http://172.17.0.1:18793/edge/provider/",
    NYLORUN_CREDENTIAL_PROVIDER_TOKEN: "t".repeat(32),
  };
  const gateway = { NYLORUN_GATES_TOKEN: "a".repeat(64), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" };

  it("is read by egress-gate and core, without the trailing slash, and by no other service", () => {
    const expected = { url: "http://172.17.0.1:18793/edge/provider", token: "t".repeat(32) };
    expect(parseStackConfig(provider, []).credentialProvider).toEqual(expected);
    expect(parseStackConfig({ ...gateway, ...provider }, ["--service", "gates,keys,egress"]).credentialProvider).toEqual(expected);
    expect(parseStackConfig({ ...gateway, ...provider }, ["--service", "gates,keys"]).credentialProvider).toBeUndefined();
    expect(parseStackConfig({}, []).credentialProvider).toBeUndefined();
    expect(
      parseStackConfig({ NYLORUN_CREDENTIAL_PROVIDER_URL: "", NYLORUN_CREDENTIAL_PROVIDER_TOKEN: "" }, []).credentialProvider,
    ).toBeUndefined();
  });

  it("needs both settings, an http or https base URL without credentials, and a token", () => {
    const parse = (env: Record<string, string>) => () => parseStackConfig(env, []);
    expect(parse({ NYLORUN_CREDENTIAL_PROVIDER_URL: provider.NYLORUN_CREDENTIAL_PROVIDER_URL })).toThrow(
      /NYLORUN_CREDENTIAL_PROVIDER_TOKEN is required/,
    );
    expect(parse({ NYLORUN_CREDENTIAL_PROVIDER_TOKEN: "t".repeat(32) })).toThrow(/without NYLORUN_CREDENTIAL_PROVIDER_URL/);
    for (const url of ["ftp://provider/x", "http://user:pass@provider/x", "https://provider/x?token=1", "not a url"])
      expect(parse({ ...provider, NYLORUN_CREDENTIAL_PROVIDER_URL: url }), url).toThrow(StackConfigError);
    expect(parse({ ...provider, NYLORUN_CREDENTIAL_PROVIDER_TOKEN: "short" })).toThrow(/at least 16/);
    expect(parse({ ...provider, NYLORUN_CREDENTIAL_PROVIDER_TOKEN: "has a space in it, long enough" })).toThrow(/no spaces/);
  });
});

describe("NYLORUN_OBJECT_STORE_*", () => {
  const store = {
    NYLORUN_OBJECT_STORE_ENDPOINT: "http://rustfs:9000/",
    NYLORUN_OBJECT_STORE_ACCESS_KEY: "nylorun",
    NYLORUN_OBJECT_STORE_SECRET_KEY: "s".repeat(64),
  };

  it("is absent without an endpoint, so the Tenant keeps blobs on disk", () => {
    expect(parseStackConfig({}, []).objectStore).toBeUndefined();
  });

  it("reads the endpoint and credential, with the default bucket and region, in every service", () => {
    const expected = {
      endpoint: "http://rustfs:9000",
      bucket: "nylorun",
      region: "us-east-1",
      accessKeyId: "nylorun",
      secretAccessKey: "s".repeat(64),
    };
    expect(parseStackConfig(store, []).objectStore).toEqual(expected);
    expect(
      parseStackConfig(
        { ...store, NYLORUN_GATES_TOKEN: "a".repeat(64), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" },
        ["--service", "gates,keys"],
      ).objectStore,
    ).toEqual(expected);
    expect(
      parseStackConfig(
        { ...store, NYLORUN_OBJECT_STORE_BUCKET: "artifacts", NYLORUN_OBJECT_STORE_REGION: "eu-west-1" },
        [],
      ).objectStore,
    ).toMatchObject({ bucket: "artifacts", region: "eu-west-1" });
  });

  it("requires the credential with the endpoint, and the endpoint with the credential", () => {
    expect(() =>
      parseStackConfig({ NYLORUN_OBJECT_STORE_ENDPOINT: "http://rustfs:9000" }, []),
    ).toThrow(/NYLORUN_OBJECT_STORE_ACCESS_KEY and NYLORUN_OBJECT_STORE_SECRET_KEY are required/);
    expect(() => parseStackConfig({ NYLORUN_OBJECT_STORE_SECRET_KEY: "x" }, [])).toThrow(
      /without NYLORUN_OBJECT_STORE_ENDPOINT/,
    );
    expect(() =>
      parseStackConfig({ ...store, NYLORUN_OBJECT_STORE_ENDPOINT: "s3://bucket" }, []),
    ).toThrow(/NYLORUN_OBJECT_STORE_ENDPOINT must use http or https/);
    expect(() =>
      parseStackConfig({ ...store, NYLORUN_OBJECT_STORE_BUCKET: "Bad_Bucket" }, []),
    ).toThrow(/NYLORUN_OBJECT_STORE_BUCKET/);
  });
});

describe("traces", () => {
  it("export nothing without an endpoint, with no content and the default service name", () => {
    expect(parseStackConfig({}, []).traces).toBeUndefined();
    expect(parseStackConfig({ OTEL_SERVICE_NAME: "agents" }, []).traces).toEqual({
      resource: { serviceName: "agents", attributes: {} },
      content: [],
    });
    expect(parseStackConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }, ["--service", "loop"]).traces).toBeUndefined();
  });

  it("post to the endpoint's /v1/traces, or to the traces endpoint, with the headers", () => {
    const traces = parseStackConfig(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
        OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=a%20b, x-team=core",
        OTEL_SERVICE_NAME: "agents",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,service.name=ignored",
      },
      [],
    ).traces;
    expect(traces).toEqual({
      resource: { serviceName: "agents", attributes: { "deployment.environment": "prod", "service.name": "ignored" } },
      content: [],
      export: { url: "http://collector:4318/v1/traces", headers: { "x-api-key": "a b", "x-team": "core" } },
    });
    expect(
      parseStackConfig(
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://b/otlp/traces" },
        [],
      ).traces?.export?.url,
    ).toBe("https://b/otlp/traces");
  });

  it("carry the content kinds opted in, or all of them with the GenAI switch", () => {
    expect(parseStackConfig({ NYLORUN_TRACE_CONTENT: "errors, user" }, []).traces?.content).toEqual(["user", "errors"]);
    expect(
      parseStackConfig({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }, []).traces?.content,
    ).toEqual(["user", "outputs", "tool-results", "errors"]);
    expect(() => parseStackConfig({ NYLORUN_TRACE_CONTENT: "prompts" }, [])).toThrow(/NYLORUN_TRACE_CONTENT/);
    expect(() => parseStackConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_HEADERS: "novalue" }, [])).toThrow(/OTEL_EXPORTER_OTLP_HEADERS/);
  });
});

describe("trace content", () => {
  const ALL = ["user", "outputs", "tool-results", "errors"];
  const contentOf = (env: Record<string, string>) => parseTraceContent(env, []).content;
  const warningsOf = (env: Record<string, string>) => {
    const warnings: { event: string; variable: string }[] = [];
    parseTraceContent(env, warnings);
    return warnings.map(({ event, variable }) => `${event} ${variable}`);
  };
  const NEW = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT";

  it.each([
    ["NO_CONTENT", [], []],
    ["SPAN_ONLY", ALL, []],
    ["span_only", ALL, []],
    [" Span_Only ", ALL, []],
    ["EVENT_ONLY", [], [`trace_content_events_unsupported ${NEW}`]],
    ["SPAN_AND_EVENT", ALL, [`trace_content_events_unsupported ${NEW}`]],
    ["everything", [], [`trace_content_unknown ${NEW}`]],
  ])("reads %j as its content, with its warnings", (value, content, warnings) => {
    expect(contentOf({ [NEW]: value })).toEqual(content);
    expect(warningsOf({ [NEW]: value })).toEqual(warnings);
  });

  it("carries no content and warns of nothing when nothing is set", () => {
    expect(parseTraceContent({}, [])).toEqual({ content: [], set: false });
    expect(warningsOf({})).toEqual([]);
  });

  it("still reads the old variables for one release, each with a deprecation warning", () => {
    expect(contentOf({ NYLORUN_TRACE_CONTENT: "errors, user" })).toEqual(["user", "errors"]);
    expect(warningsOf({ NYLORUN_TRACE_CONTENT: "errors" })).toEqual(["trace_content_deprecated NYLORUN_TRACE_CONTENT"]);
    expect(contentOf({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "TRUE" })).toEqual(ALL);
    expect(contentOf({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false" })).toEqual([]);
    expect(warningsOf({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" })).toEqual([
      "trace_content_deprecated OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
    ]);
    expect(() => parseTraceContent({ NYLORUN_TRACE_CONTENT: "prompts" })).toThrow(/NYLORUN_TRACE_CONTENT/);
  });

  it("lets the new switch win over the old variables, which are then ignored", () => {
    const env = {
      [NEW]: "NO_CONTENT",
      NYLORUN_TRACE_CONTENT: "user",
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
    };
    expect(contentOf(env)).toEqual([]);
    expect(warningsOf(env)).toEqual([
      "trace_content_deprecated NYLORUN_TRACE_CONTENT",
      "trace_content_deprecated OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
    ]);
  });

  it("puts the content on the process's traces, and the warnings on its config, never failing the start", () => {
    const config = parseStackConfig({ [NEW]: "bogus" }, CORE);
    expect(config.traces).toEqual({ resource: { serviceName: "nylorun-runtime", attributes: {} }, content: [] });
    expect(config.warnings?.map((warning) => warning.event)).toEqual(["trace_content_unknown"]);
    expect(parseStackConfig({ [NEW]: "SPAN_ONLY" }, CORE).traces?.content).toEqual(ALL);
  });
});

describe("telemetry", () => {
  const gates = { NYLORUN_GATES_TOKEN: "a".repeat(64), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" };
  const container = { NYLORUN_ALLOWED_HOSTS: "runtime:4000" };

  it("serves /metrics on 0.0.0.0:9464 in a container, loopback for a local Host, and names each process", () => {
    expect(parseStackConfig(container, CORE).telemetry).toEqual(telemetryOf("nylorun-runtime", "0.0.0.0"));
    expect(parseStackConfig({}, CORE).telemetry).toEqual(telemetryOf("nylorun-runtime", "127.0.0.1"));
    expect(parseStackConfig(gates, ["--service", "gates,keys,egress"]).telemetry).toEqual(
      telemetryOf("nylorun-gateway", "0.0.0.0"),
    );
    expect(parseStackConfig({ ...gates, NYLORUN_EGRESS_LISTEN_PORT: "4200" }, ["--service", "egress"]).telemetry?.resource.serviceName).toBe(
      "nylorun-gateway",
    );
    expect(
      parseStackConfig(
        { ...container, OTEL_EXPORTER_PROMETHEUS_HOST: "127.0.0.1", OTEL_EXPORTER_PROMETHEUS_PORT: "9555" },
        CORE,
      ).telemetry?.metrics.prometheus,
    ).toEqual({ host: "127.0.0.1", port: 9555 });
    expect(() => parseStackConfig({ OTEL_EXPORTER_PROMETHEUS_PORT: "http" }, CORE)).toThrow(/OTEL_EXPORTER_PROMETHEUS_PORT/);
  });

  it("lets OTEL_SERVICE_NAME, then the resource attributes' service.name, win", () => {
    expect(parseStackConfig({ ...container, OTEL_SERVICE_NAME: "agents" }, CORE).telemetry?.resource).toEqual({
      serviceName: "agents",
      attributes: {},
    });
    expect(
      parseStackConfig({ ...gates, OTEL_RESOURCE_ATTRIBUTES: "service.name=edge,deployment.environment=prod" }, [
        "--service",
        "gates",
      ]).telemetry?.resource,
    ).toEqual({ serviceName: "edge", attributes: { "deployment.environment": "prod" } });
  });

  it("pushes metrics and spans over OTLP only with an endpoint, the signal's own winning", () => {
    const telemetry = parseStackConfig(
      {
        ...container,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
        OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example/otlp",
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-api-key=m",
      },
      CORE,
    ).telemetry;
    expect(telemetry?.metrics).toEqual({
      prometheus: { host: "0.0.0.0", port: 9464 },
      otlp: { url: "https://metrics.example/otlp", headers: { "x-api-key": "m" } },
    });
    expect(telemetry?.traces).toEqual({
      url: "http://collector:4318/v1/traces",
      headers: { "x-api-key": "k" },
      sampler: { name: "parentbased_always_on", ratio: 1 },
    });
    expect(parseStackConfig(container, CORE).telemetry?.traces).toBeUndefined();
  });

  it("reads OTEL_METRICS_EXPORTER as a list of prometheus, otlp and none", () => {
    const metricsOf = (value: string, env: Record<string, string> = {}) =>
      parseStackConfig({ ...container, ...env, OTEL_METRICS_EXPORTER: value }, CORE).telemetry?.metrics;
    expect(metricsOf("none")).toEqual({});
    expect(metricsOf("otlp")).toEqual({ otlp: { url: "http://localhost:4318/v1/metrics", headers: {} } });
    expect(metricsOf("otlp", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })).toEqual({
      otlp: { url: "http://c:4318/v1/metrics", headers: {} },
    });
    expect(metricsOf("Prometheus, otlp", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })).toMatchObject({
      prometheus: { port: 9464 },
      otlp: { url: "http://c:4318/v1/metrics" },
    });
    const config = parseStackConfig({ ...container, OTEL_METRICS_EXPORTER: "prometheus,statsd" }, CORE);
    expect(config.telemetry?.metrics).toEqual({ prometheus: { host: "0.0.0.0", port: 9464 } });
    expect(config.warnings).toEqual([expect.objectContaining({ variable: "OTEL_METRICS_EXPORTER" })]);
  });

  it.each([
    [{}, { name: "parentbased_always_on", ratio: 1 }, 0],
    [{ OTEL_TRACES_SAMPLER: "always_off" }, { name: "always_off", ratio: 1 }, 0],
    [{ OTEL_TRACES_SAMPLER: "ALWAYS_ON" }, { name: "always_on", ratio: 1 }, 0],
    [{ OTEL_TRACES_SAMPLER: "parentbased_always_on" }, { name: "parentbased_always_on", ratio: 1 }, 0],
    [{ OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: "0.25" }, { name: "traceidratio", ratio: 0.25 }, 0],
    [
      { OTEL_TRACES_SAMPLER: "parentbased_traceidratio", OTEL_TRACES_SAMPLER_ARG: "0.1" },
      { name: "parentbased_traceidratio", ratio: 0.1 },
      0,
    ],
    [{ OTEL_TRACES_SAMPLER: "parentbased_traceidratio", OTEL_TRACES_SAMPLER_ARG: "2" }, { name: "parentbased_traceidratio", ratio: 1 }, 1],
    [{ OTEL_TRACES_SAMPLER: "jaeger_remote" }, { name: "parentbased_always_on", ratio: 1 }, 1],
  ])("samples %j as %j", (env, sampler, warnings) => {
    const config = parseStackConfig({ ...container, OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", ...env }, CORE);
    expect(config.telemetry?.traces?.sampler).toEqual(sampler);
    expect(config.warnings ?? []).toHaveLength(warnings);
  });

  it("has none for the harness or a computer, which run alone", () => {
    expect(
      parseStackConfig(
        {
          NYLORUN_HARNESS_URL: "ws://runtime:4200/nylorun/harness/v1",
          NYLORUN_HARNESS_TOKEN: HARNESS_TOKEN,
          NYLORUN_GATES_URL: "http://gateway:4100",
        },
        ["--service", "harness"],
      ).telemetry,
    ).toBeUndefined();
  });
});
