import { describe, expect, it } from "vitest";
import {
  parseServices,
  parseStackConfig,
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

  it("runs keys with gates (F4.2), and never with core or loop", () => {
    expect(parseServices(["--service", "gates,keys"])).toEqual({ services: services("gates", "keys") });
    expect(() => parseServices(["--service", "core,keys"])).toThrow(/may not share a process/);
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
    expect(() => parseServices(["--service", "egress"])).toThrow(/not in this release/);
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
      tenant: { name: "default", derivedPrincipals: ["project"] },
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
        s2Endpoint: "http://s2:80",
        s2Token: "ignored",
        workspaceStoreUrl: "file:///workspaces",
      },
      tenant: { name: "default", derivedPrincipals: ["project"] },
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
      tenant: { name: "default", derivedPrincipals: ["project"] },
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
    // core pings Action endpoints through the Tool Gate (F4.1).
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

  it("keeps the loopback rule when no allowlist is given", () => {
    expect(isAllowedRequestHost("localhost:4000", { port: 4000, host: "127.0.0.1" })).toBe(true);
    expect(isAllowedRequestHost("runtime:4000", { port: 4000, host: "127.0.0.1" })).toBe(false);
  });
});

describe("NYLORUN_BROWSER_ACCESS", () => {
  it("is absent by default and on or off when set", () => {
    expect(parseStackConfig({}, []).browserAccess).toBeUndefined();
    expect(parseStackConfig({ NYLORUN_BROWSER_ACCESS: "on" }, []).browserAccess).toBe(true);
    expect(parseStackConfig({ NYLORUN_BROWSER_ACCESS: "off" }, []).browserAccess).toBe(false);
  });

  it("rejects anything else", () => {
    expect(() => parseStackConfig({ NYLORUN_BROWSER_ACCESS: "yes" }, [])).toThrow(
      StackConfigError
    );
  });
});

describe("NYLORUN_ADMIN_LISTEN_*", () => {
  const base = {
    NYLORUN_LISTEN_HOST: "0.0.0.0",
    NYLORUN_LISTEN_PORT: "4000",
    NYLORUN_ALLOWED_HOSTS: "runtime:4000",
  };

  it("is one listener when unset", () => {
    expect(parseStackConfig(base, CORE).operator).toBeUndefined();
  });

  it("adds the operator listener with its own Host allowlist", () => {
    const config = parseStackConfig(
      {
        ...base,
        NYLORUN_ADMIN_LISTEN_PORT: "4001",
        NYLORUN_ADMIN_ALLOWED_HOSTS: "runtime:4001,localhost:8788",
      },
      CORE
    );
    expect(config.operator).toEqual({
      host: "0.0.0.0",
      port: 4001,
      allowedHosts: ["runtime:4001", "localhost:8788", "localhost:4001", "127.0.0.1:4001", "[::1]:4001"],
    });
  });

  it("requires an allowlist off loopback, a port with the other variables, and a port of its own", () => {
    expect(() => parseStackConfig({ ...base, NYLORUN_ADMIN_LISTEN_PORT: "4001" }, CORE)).toThrow(
      /NYLORUN_ADMIN_ALLOWED_HOSTS is required/
    );
    expect(() =>
      parseStackConfig({ ...base, NYLORUN_ADMIN_ALLOWED_HOSTS: "runtime:4001" }, CORE)
    ).toThrow(/NYLORUN_ADMIN_LISTEN_PORT is required/);
    expect(() =>
      parseStackConfig(
        { ...base, NYLORUN_ADMIN_LISTEN_PORT: "4000", NYLORUN_ADMIN_ALLOWED_HOSTS: "runtime:4000" },
        CORE
      )
    ).toThrow(/must differ/);
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
  it("defaults to a new id, the name default and the project derived principal", () => {
    expect(parseStackConfig({}, []).tenant).toEqual({
      name: "default",
      derivedPrincipals: ["project"],
    });
    // The gates service creates no Tenant.
    const gates = { NYLORUN_GATES_TOKEN: "ab".repeat(32), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" };
    expect(parseStackConfig(gates, ["--service", "gates"]).tenant).toBeUndefined();
  });

  it("reads NYLORUN_TENANT_ID, NYLORUN_TENANT_NAME and NYLORUN_DERIVED_PRINCIPALS", () => {
    expect(
      parseStackConfig(
        {
          NYLORUN_TENANT_ID: "tn_0123456789abcdefghjkmnpqrs",
          NYLORUN_TENANT_NAME: "my-app",
          NYLORUN_DERIVED_PRINCIPALS: "project, babai,project",
        },
        [],
      ).tenant,
    ).toEqual({
      id: "tn_0123456789abcdefghjkmnpqrs",
      name: "my-app",
      derivedPrincipals: ["project", "babai"],
    });
  });

  it("rejects a malformed Tenant id and reserved or malformed principal ids, naming the variable", () => {
    expect(() => parseStackConfig({ NYLORUN_TENANT_ID: "tn_nope" }, [])).toThrow(/NYLORUN_TENANT_ID/);
    expect(() => parseStackConfig({ NYLORUN_DERIVED_PRINCIPALS: "studio" }, [])).toThrow(
      /NYLORUN_DERIVED_PRINCIPALS/,
    );
    expect(() => parseStackConfig({ NYLORUN_DERIVED_PRINCIPALS: "Bad_Id" }, [])).toThrow(
      /NYLORUN_DERIVED_PRINCIPALS/,
    );
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
