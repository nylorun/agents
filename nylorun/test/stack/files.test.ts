import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderComposeFile } from "../../src/stack/compose-file.js";
import {
  parseDerivedPrincipals,
  parseEnvLines,
  parsePersisted,
  renderEnvFile,
  type StackEnv,
} from "../../src/stack/env-file.js";
import { stackImages } from "../../src/stack/images.js";
import { stackPaths } from "../../src/stack/paths.js";
import { choosePort } from "../../src/stack/ports.js";
import { prepareStack } from "../../src/stack/prepare.js";
import { identityPublicKey } from "../../src/stack/restate-identity.js";
import { fakePorts, temporaryHome } from "./support.js";

const env: StackEnv = {
  runtimePort: 8787,
  adminPort: 8788,
  studioPort: 4161,
  restatePort: 9070,
  restateUi: false,
  postgresPassword: "0123456789abcdef0123456789abcdef0123456789abcdef",
  gatesToken: "fedcba9876543210".repeat(4),
  harnessToken: "a1b2c3d4".repeat(8),
  harness: "remote",
  objectStoreSecretKey: "0123abcd".repeat(8),
  restateIdentityKey: "publickeyv1_CgojDdtCBsK8zYsbqruLmwXgWqMYxDfu3n5qJdcJeNtv",
  uid: 501,
  gid: 20,
  hostRoot: "/Users/dev/.nylorun/tenants/shop",
  runtimeImage: "ghcr.io/nylorun/runtime:0.10.0-beta",
  studioImage: "ghcr.io/nylorun/studio:0.9.0-beta",
  studioFrameAncestors: "nylorun://localhost http://nylorun.localhost",
  studioAnalyticsId: "G-K6RPDFH6Q6",
  tenantName: "shop",
  derivedPrincipals: "project,babai",
};

/** Fixed vector: Restate 1.7.12 logs `kid: <FIXED_KEY>` when it loads this PEM. */
const FIXED_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMcoQgQeU+ZVIXPH9VEJPNg5zs
-----END PRIVATE KEY-----
`;
const FIXED_KEY = "publickeyv1_9X4RmZSyRwtembhvBJbbemS2epiX6hHJT9yt2ABTh8SR";

const images = stackImages({}, { runtime: "0.10.0-beta", studio: "0.9.0-beta" });

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("compose.yaml", () => {
  const compose = renderComposeFile("nylorun-shop", "shop");

  it("matches the committed file", () => {
    expect(compose).toMatchSnapshot();
  });

  it("is the Tenant's own Compose project, whose Runtime creates the Tenant", () => {
    expect(compose).toMatch(/^name: nylorun-shop$/m);
    const runtime = compose.slice(compose.indexOf("  runtime:"), compose.indexOf("  studio:"));
    expect(runtime).toContain("NYLORUN_TENANT_NAME: ${NYLORUN_TENANT_NAME:?run nylorun start}");
    expect(runtime).toContain("NYLORUN_DERIVED_PRINCIPALS: ${NYLORUN_DERIVED_PRINCIPALS:-project}");
    expect(runtime).not.toContain("NYLORUN_TENANT_ID");
  });

  it("initialises Postgres with C collation", () => {
    expect(compose).toContain('POSTGRES_INITDB_ARGS: "--locale=C"');
  });

  const publishedOf = (text: string) =>
    [...text.matchAll(/^\s+- "([^"]+):(\d+)"/gm)].map((m) => `${m[1]}:${m[2]}`);

  it("publishes only the Runtime, its operator port and Studio, all on loopback", () => {
    expect(publishedOf(compose)).toEqual([
      "127.0.0.1:${NYLORUN_PORT:?run nylorun start}:4000",
      "127.0.0.1:${NYLORUN_ADMIN_PORT:?run nylorun start}:4001",
      "127.0.0.1:${NYLORUN_STUDIO_PORT:?run nylorun start}:3000",
    ]);
  });

  it("publishes Restate's UI on loopback only with restateUi, joining it to the default network", () => {
    const restate = (text: string) => text.slice(text.indexOf("\n  restate:"), text.indexOf("\n  s2-lite:"));
    expect(restate(compose)).toContain("    networks: [store] #");
    expect(restate(compose)).not.toMatch(/^\s+ports:/m);
    const debug = renderComposeFile("nylorun-shop", "shop", { restateUi: true });
    expect(publishedOf(debug)[0]).toBe("127.0.0.1:${NYLORUN_RESTATE_PORT:?run nylorun start}:9070");
    expect(restate(debug)).toContain("    networks: [store, default]\n");
  });

  /** A service's block, from its key to the next service's. */
  const service = (text: string, name: string) => {
    const start = text.indexOf(`\n  ${name}:`);
    const end = text.indexOf("\n  ", text.indexOf("\n    restart:", start) + 1);
    return text.slice(start, end === -1 ? undefined : end);
  };

  it("splits the networks: the stores on an internal one, the harness on its own (F6.2)", () => {
    expect(compose).toContain("  store: # the stores: no egress, no published port\n    name: nylorun-shop-store\n    internal: true\n");
    expect(compose).toMatch(/\n {2}harness: #[^\n]*\n {4}name: nylorun-shop-harness\n {4}labels/);
    const networks = (name: string) => /\n {4}networks: \[([^\]]*)\]/.exec(service(compose, name))?.[1];
    expect(networks("postgres")).toBe("store");
    expect(networks("s2-lite")).toBe("store");
    expect(networks("rustfs")).toBe("store");
    expect(networks("restate")).toBe("store");
    expect(networks("gateway")).toBe("default, store, harness");
    expect(networks("runtime")).toBe("default, store, harness");
    expect(networks("studio")).toBe("default");
    expect(networks("harness")).toBe("harness");
    const sandboxes = renderComposeFile("nylorun-shop", "shop", { sandboxes: true });
    expect(/\n {4}networks: \[([^\]]*)\]/.exec(service(sandboxes, "sandboxes"))?.[1]).toBe("default");
  });

  it("runs the harness from the runtime image with only its token and its own directories", () => {
    const harness = service(compose, "harness");
    expect(harness).toContain("image: ${NYLORUN_RUNTIME_IMAGE:?run nylorun start}\n");
    expect(harness).toContain('command: ["--service", "harness"]');
    expect(harness).toContain('user: "${NYLORUN_UID:?run nylorun start}:${NYLORUN_GID:?run nylorun start}"');
    expect(harness).toContain("runtime: { condition: service_healthy }");
    expect(harness).toContain("gateway: { condition: service_healthy }");
    expect(harness).toContain("NYLORUN_HARNESS_URL: ws://runtime:4200/nylorun/harness/v1\n");
    expect(harness).toContain("NYLORUN_HARNESS_TOKEN: ${NYLORUN_HARNESS_TOKEN:?run nylorun start}\n");
    expect(harness).toContain("NYLORUN_GATES_URL: http://gateway:4100\n");
    expect(harness).toContain("NYLORUN_HARNESS_ROOT: /harness\n");
    expect(harness).toContain("http://127.0.0.1:4300/health");
    expect(harness).not.toMatch(/^\s+ports:|GATES_TOKEN|DATABASE_URL|KEYS_URL|RESTATE|OBJECT_STORE|POSTGRES|extra_hosts/m);
    const mounts = [...harness.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1]);
    expect(mounts).toEqual([
      ...["sandboxes", "plugin-data", "home", "tmp"].map(
        (dir) => `\${NYLORUN_HOST_ROOT:?run nylorun start}/tenant/${dir}:/harness/${dir}`,
      ),
      "${NYLORUN_HOST_ROOT:?run nylorun start}/plugins:${NYLORUN_HOST_ROOT:?run nylorun start}/plugins:ro",
    ]);
    // The harness token reaches the runtime (which checks it) and the harness, nothing else.
    expect(compose.match(/\$\{NYLORUN_HARNESS_TOKEN/g)).toHaveLength(2);
    expect(service(compose, "gateway")).not.toContain("HARNESS");
  });

  it("starts core's Harness API listener, remote unless .env says in-process", () => {
    const runtime = service(compose, "runtime");
    expect(runtime).toContain("NYLORUN_HARNESS: ${NYLORUN_HARNESS:-remote}\n");
    expect(runtime).toContain('NYLORUN_HARNESS_LISTEN_PORT: "4200"\n');
    expect(runtime).toContain("NYLORUN_HARNESS_ALLOWED_HOSTS: runtime:4200\n");
    expect(runtime).toContain(
      "- ${NYLORUN_HOST_ROOT:?run nylorun start}/plugins:${NYLORUN_HOST_ROOT:?run nylorun start}/plugins:ro",
    );
    const rollback = renderComposeFile("nylorun-shop", "shop", { harness: "in-process" });
    expect(rollback).not.toContain("container_name: nylorun-shop-harness");
    expect(rollback).toContain("NYLORUN_HARNESS: ${NYLORUN_HARNESS:-remote}\n");
  });

  it("lets the Runtime deliver Actions to endpoints on this machine", () => {
    expect(compose).toContain("NYLORUN_ENDPOINT_LOOPBACK: docker-host");
    expect(compose).toContain("host.docker.internal: host-gateway");
  });

  it("serves the Admin API on the operator listener, which Studio uses", () => {
    expect(compose).toContain('NYLORUN_ADMIN_LISTEN_PORT: "4001"');
    expect(compose).toContain(
      "NYLORUN_ADMIN_ALLOWED_HOSTS: runtime:4001,localhost:${NYLORUN_ADMIN_PORT},127.0.0.1:${NYLORUN_ADMIN_PORT}",
    );
    expect(compose).toContain("NYLORUN_RUNTIME_URL: http://runtime:4001");
  });

  it("pins Postgres, Restate, s2 and RustFS (by digest) and takes the Runtime and Studio images from .env", () => {
    expect(compose).toContain(
      "image: rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c\n",
    );
    expect(compose).toContain("image: postgres:17.11\n");
    expect(compose).toContain("image: docker.restate.dev/restatedev/restate:1.7.12\n");
    expect(compose).toContain("image: ghcr.io/s2-streamstore/s2:0.43.0\n");
    expect(compose).toContain("image: ${NYLORUN_RUNTIME_IMAGE:?run nylorun start}\n");
    expect(compose).toContain("image: ${NYLORUN_STUDIO_IMAGE:?run nylorun start}\n");
  });

  it("runs the Runtime as the developer, in container mode, with the Host root bind-mounted", () => {
    expect(compose).toContain('user: "${NYLORUN_UID:?run nylorun start}:${NYLORUN_GID:?run nylorun start}"');
    expect(compose).toContain(
      "NYLORUN_ALLOWED_HOSTS: runtime:4000,localhost:${NYLORUN_PORT},127.0.0.1:${NYLORUN_PORT}",
    );
    expect(compose).toContain("- ${NYLORUN_HOST_ROOT:?run nylorun start}:/nylorun # Host root");
    expect(compose).toContain(
      "- ${NYLORUN_HOST_ROOT}/host-credentials.json:/run/nylorun/host-credentials.json:ro",
    );
    expect(compose).toContain("NYLORUN_STUDIO_PUBLIC_PORT: ${NYLORUN_STUDIO_PORT}");
    expect(compose).toContain("NYLORUN_PUBLIC_URL: http://localhost:${NYLORUN_PORT}");
  });

  it("packs core and loop into runtime and the Model Gate into gateway (combined packing)", () => {
    expect(compose).toContain('command: ["--service", "core,loop"]');
    expect(compose).toContain('command: ["--service", "gates,keys"]');
    expect(compose).toContain("NYLORUN_GATES_URL: http://gateway:4100");
    expect(compose).toContain("NYLORUN_KEYS_URL: http://gateway:4100");
    expect(compose).toContain("NYLORUN_GATES_ALLOWED_HOSTS: gateway:4100");
    expect(compose.match(/NYLORUN_GATES_TOKEN: \$\{NYLORUN_GATES_TOKEN:\?run nylorun start\}/g)).toHaveLength(2);
    expect(compose.match(/NYLORUN_PACKING: combined/g)).toHaveLength(2);
  });

  it("mounts only the Tenant directory into the gateway, read-only, and never the admin key", () => {
    const gateway = compose.slice(compose.indexOf("  gateway:"), compose.indexOf("  runtime:"));
    expect(gateway).toContain("- ${NYLORUN_HOST_ROOT:?run nylorun start}/tenant:/nylorun/tenant:ro");
    expect(gateway).toContain("- ${NYLORUN_HOST_ROOT:?run nylorun start}/keys:/nylorun/keys:ro");
    expect(gateway).not.toContain("host-credentials");
    expect(gateway).not.toMatch(/^\s+ports:/m);
    // The runtime does not wait for the gateway: a gate outage fails model calls, nothing else.
    const runtime = compose.slice(compose.indexOf("  runtime:"), compose.indexOf("  studio:"));
    expect(runtime).not.toContain("gateway: {");
  });

  it("hides the vault key and the Compose secrets from the runtime container (F4.2)", () => {
    const runtime = compose.slice(compose.indexOf("  runtime:"), compose.indexOf("  studio:"));
    for (const target of ["/nylorun/keys", "/nylorun/docker"])
      expect(runtime).toMatch(
        new RegExp(`- type: tmpfs\\n\\s+target: ${target}\\n\\s+read_only: true`),
      );
    // Nothing but the gateway mounts keys/.
    const others = compose.slice(0, compose.indexOf("  gateway:")) + compose.slice(compose.indexOf("  runtime:"));
    expect(others).not.toContain("/keys:/nylorun/keys");
  });

  it("keeps s2-lite's data in a volume its non-root user can write", () => {
    expect(compose).toContain('command: ["lite", "--local-root", "/home/nonroot/data"]');
    expect(compose).toContain("- s2-lite:/home/nonroot\n");
    expect(compose).toContain("NYLORUN_S2_ENDPOINT: http://s2-lite:80\n");
  });

  it("names every container, the network and every volume after the Compose project, with the Tenant's label", () => {
    const names = [...compose.matchAll(/^ {4}container_name: (\S+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(
      ["postgres", "restate", "s2-lite", "rustfs", "gateway", "runtime", "studio", "harness"].map(
        (role) => `nylorun-shop-${role}`,
      ),
    );
    expect(compose).toContain('x-tenant: &tenant\n  dev.nylorun.tenant: "shop"\n');
    expect(compose.match(/^ {4}labels: \*tenant$/gm)).toHaveLength(11); // eight services and three networks
    expect(compose).toContain("networks:\n  default:\n    name: nylorun-shop\n");
    for (const volume of ["postgres", "restate", "s2-lite", "rustfs", "workspaces"])
      expect(compose).toContain(`  ${volume}: { name: nylorun-shop-${volume}, labels: *tenant }\n`);
  });

  it("runs RustFS on a named volume and gives its credential only to the runtime and the gateway", () => {
    const service = (name: string) => {
      const start = compose.indexOf(`\n  ${name}:`);
      const end = compose.indexOf("\n  ", compose.indexOf("\n    restart:", start) + 1);
      return compose.slice(start, end === -1 ? undefined : end);
    };
    const rustfs = service("rustfs");
    expect(rustfs).toContain("- rustfs:/data\n");
    expect(rustfs).toContain("RUSTFS_ACCESS_KEY: nylorun\n");
    expect(rustfs).toContain("RUSTFS_SECRET_KEY: ${NYLORUN_OBJECT_STORE_SECRET_KEY:?run nylorun start}\n");
    expect(rustfs).not.toMatch(/^\s+ports:/m);
    for (const name of ["runtime", "gateway"]) {
      const block = service(name);
      expect(block).toContain("NYLORUN_OBJECT_STORE_ENDPOINT: http://rustfs:9000\n");
      expect(block).toContain("NYLORUN_OBJECT_STORE_ACCESS_KEY: nylorun\n");
      expect(block).toContain(
        "NYLORUN_OBJECT_STORE_SECRET_KEY: ${NYLORUN_OBJECT_STORE_SECRET_KEY:?run nylorun start}\n",
      );
    }
    // The secret appears in rustfs, the runtime and the gateway, nowhere else.
    expect(compose.match(/\$\{NYLORUN_OBJECT_STORE_SECRET_KEY/g)).toHaveLength(3);
    for (const name of ["postgres", "restate", "s2-lite", "studio"])
      expect(service(name)).not.toContain("OBJECT_STORE");
    expect(service("runtime")).toContain("rustfs: { condition: service_healthy }");
  });

  it("leaves Restate's memory settings at Restate's defaults", () => {
    expect(compose).not.toContain("RESTATE_ROCKSDB");
  });

  it("gives Studio a session cookie of its own", () => {
    const studio = compose.slice(compose.indexOf("  studio:"));
    expect(studio).toContain("NYLORUN_STUDIO_SESSION_COOKIE: nylorun_studio_shop\n");
  });

  it("mounts the Restate identity key read-only into Restate and gives the Runtime its public key", () => {
    expect(compose).toContain(
      "RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE: /run/nylorun/restate-identity.pem",
    );
    expect(compose).toContain(
      "- ${NYLORUN_HOST_ROOT:?run nylorun start}/docker/restate-identity.pem:/run/nylorun/restate-identity.pem:ro",
    );
    expect(compose).toContain(
      "NYLORUN_RESTATE_IDENTITY_KEY: ${NYLORUN_RESTATE_IDENTITY_KEY:?run nylorun start}",
    );
  });
});

describe(".env", () => {
  it("renders every setting, including the Restate identity public key", () => {
    expect(renderEnvFile(env)).toMatchSnapshot();
    expect(parseEnvLines(renderEnvFile(env)).get("NYLORUN_RESTATE_IDENTITY_KEY")).toBe(
      env.restateIdentityKey,
    );
  });

  it("round-trips the persisted settings", () => {
    expect(parsePersisted(renderEnvFile(env))).toEqual({
      runtimePort: 8787,
      adminPort: 8788,
      studioPort: 4161,
      restatePort: 9070,
      postgresPassword: env.postgresPassword,
      gatesToken: env.gatesToken,
      harnessToken: env.harnessToken,
      harness: "remote",
      objectStoreSecretKey: env.objectStoreSecretKey,
      studioFrameAncestors: ["nylorun://localhost", "http://nylorun.localhost"],
      derivedPrincipals: ["project", "babai"],
    });
    expect(renderEnvFile(env)).toContain(
      "NYLORUN_STUDIO_FRAME_ANCESTORS='nylorun://localhost http://nylorun.localhost'",
    );
    // Restate's UI is decided on every start; the last choice is read back for status.
    expect(parsePersisted(renderEnvFile({ ...env, restateUi: true })).restateUi).toBe(true);
    expect(parsePersisted('NYLORUN_HARNESS=sideways\n').harness).toBeUndefined();
  });

  it("refuses a persisted frame allowlist with a wildcard", () => {
    expect(() => parsePersisted("NYLORUN_STUDIO_FRAME_ANCESTORS='*'\n")).toThrow(
      /NYLORUN_STUDIO_FRAME_ANCESTORS in docker\/.env: \* is not an exact origin/,
    );
    expect(parsePersisted("NYLORUN_STUDIO_FRAME_ANCESTORS=\n")).toEqual({ studioFrameAncestors: [] });
  });

  it("quotes paths with spaces and refuses single quotes", () => {
    const text = renderEnvFile({ ...env, hostRoot: "/Users/A Dev/.nylorun/tenants/shop" });
    expect(text).toContain("NYLORUN_HOST_ROOT='/Users/A Dev/.nylorun/tenants/shop'");
    expect(parseEnvLines(text).get("NYLORUN_HOST_ROOT")).toBe("/Users/A Dev/.nylorun/tenants/shop");
    expect(() => renderEnvFile({ ...env, hostRoot: "/it's" })).toThrow(/single quote/);
  });

  it("keeps `project` first among the derived principals and refuses studio", () => {
    expect(parseDerivedPrincipals("babai, project ,", "X")).toEqual(["project", "babai"]);
    expect(() => parseDerivedPrincipals("studio", "X")).toThrow(/X has 'studio'/);
    expect(() => parseDerivedPrincipals("Bad", "X")).toThrow(/X has 'Bad'/);
  });

  it("ignores malformed persisted values", () => {
    expect(
      parsePersisted("NYLORUN_PORT=99999\nNYLORUN_STUDIO_PORT=abc\nNYLORUN_POSTGRES_PASSWORD=short\n"),
    ).toEqual({});
  });
});

describe("images", () => {
  it("defaults to the pinned tags and honours overrides", () => {
    expect(images.runtime).toBe("ghcr.io/nylorun/runtime:0.10.0-beta");
    expect(images.studio).toBe("ghcr.io/nylorun/studio:0.9.0-beta");
    const overridden = stackImages(
      { NYLORUN_RUNTIME_IMAGE: "nylorun-runtime:dev", NYLORUN_STUDIO_IMAGE: " " },
      { runtime: "1", studio: "2" },
    );
    expect(overridden.runtime).toBe("nylorun-runtime:dev");
    expect(overridden.studio).toBe("ghcr.io/nylorun/studio:2");
  });
});

describe("ports", () => {
  it("keeps a persisted port, else the default when free, else a free one", async () => {
    expect(await choosePort(fakePorts([8787]), 8787, 8800, new Set())).toBe(8800);
    expect(await choosePort(fakePorts(), 8787, undefined, new Set())).toBe(8787);
    expect(await choosePort(fakePorts([8787]), 8787, undefined, new Set())).toBe(50000);
    expect(await choosePort(fakePorts(), 8787, undefined, new Set([8787]))).toBe(50000);
    expect(await choosePort(fakePorts(), 8787, 4161, new Set([4161]))).toBe(8787);
  });
});

describe("prepareStack", () => {
  const prepare = (
    home: string,
    ports = fakePorts(),
    overrides: {
      uid?: number;
      runtimeImage?: string;
      studioEmbedOrigins?: { add?: readonly string[]; reset?: boolean };
      reserved?: number[];
      derivedPrincipals?: string;
    } = {},
  ) =>
    prepareStack({
      paths: stackPaths(home),
      name: "shop",
      project: "nylorun-shop",
      ...(overrides.reserved ? { reserved: new Set(overrides.reserved) } : {}),
      ...(overrides.derivedPrincipals ? { derivedPrincipals: overrides.derivedPrincipals } : {}),
      images: { ...images, ...(overrides.runtimeImage ? { runtime: overrides.runtimeImage } : {}) },
      uid: overrides.uid ?? 501,
      gid: 20,
      runtimeVersion: "0.10.0-beta",
      ports,
      ...(overrides.studioEmbedOrigins ? { studioEmbedOrigins: overrides.studioEmbedOrigins } : {}),
    });

  it("lets Babai's origins embed Studio by default, keeps additions, and resets them", async () => {
    const home = await temporaryHome();
    const first = await prepare(home);
    expect(first.env.studioFrameAncestors).toBe("nylorun://localhost http://nylorun.localhost");
    const added = await prepare(home, fakePorts(), {
      studioEmbedOrigins: { add: ["http://localhost:1420", "nylorun://localhost"] },
    });
    expect(added.env.studioFrameAncestors).toBe(
      "nylorun://localhost http://nylorun.localhost http://localhost:1420",
    );
    // Kept across starts without the option.
    expect((await prepare(home)).env.studioFrameAncestors).toBe(added.env.studioFrameAncestors);
    const reset = await prepare(home, fakePorts(), { studioEmbedOrigins: { reset: true } });
    expect(reset.env.studioFrameAncestors).toBe("nylorun://localhost http://nylorun.localhost");
    await expect(
      prepare(home, fakePorts(), { studioEmbedOrigins: { add: ["https://*.example.com"] } }),
    ).rejects.toThrow(/--studio-embed-origin: https:\/\/\*\.example\.com is not an exact origin/);
  });

  it("writes host.json, credentials, compose.yaml and .env with the right modes", async () => {
    const home = await temporaryHome();
    const paths = stackPaths(home);
    const prepared = await prepare(home);
    expect(prepared.firstRun).toBe(true);
    expect(prepared.env).toMatchObject({ runtimePort: 8787, adminPort: 8788, studioPort: 4161, restatePort: 9070, uid: 501, gid: 20, hostRoot: paths.root });
    expect(prepared.env.postgresPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(prepared.env.gatesToken).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.env.objectStoreSecretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.env.objectStoreSecretKey).not.toBe(prepared.env.gatesToken);
    expect(prepared.env.restateIdentityKey).toMatch(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const pem = await readFile(paths.restateIdentity, "utf8");
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(identityPublicKey(pem)).toBe(prepared.env.restateIdentityKey);
    expect(await mode(paths.restateIdentity)).toBe(0o600);
    expect(parseEnvLines(await readFile(paths.env, "utf8")).get("NYLORUN_RESTATE_IDENTITY_KEY")).toBe(
      prepared.env.restateIdentityKey,
    );

    const host = JSON.parse(await readFile(paths.config, "utf8"));
    expect(host).toEqual({
      format: 1,
      hostId: expect.stringMatching(/^host_[0-9a-hjkmnp-tv-z]{26}$/),
      host: "localhost",
      port: 8787,
      adminPort: 8788,
      runtimeVersion: "0.10.0-beta",
    });
    const credentials = JSON.parse(await readFile(paths.credentials, "utf8"));
    expect(credentials).toEqual({ adminKey: prepared.adminKey });
    expect(prepared.adminKey).toMatch(/^[0-9a-f]{64}$/);

    expect(await mode(paths.credentials)).toBe(0o600);
    expect(await mode(paths.env)).toBe(0o600);
    expect(await mode(paths.config)).toBe(0o600);
    expect(await mode(paths.root)).toBe(0o700);
    expect(await mode(paths.docker)).toBe(0o700);
    expect(await readFile(paths.compose, "utf8")).toBe(renderComposeFile("nylorun-shop", "shop"));
    expect(await mode(paths.tenant)).toBe(0o700);
    const written = parseEnvLines(await readFile(paths.env, "utf8"));
    expect(written.get("NYLORUN_TENANT_NAME")).toBe("shop");
    expect(written.get("NYLORUN_DERIVED_PRINCIPALS")).toBe("project");
  });

  it("points the runtime at identity.yaml only while the Host root has one", async () => {
    const home = await temporaryHome();
    const paths = stackPaths(home);
    await prepare(home);
    expect(await readFile(paths.compose, "utf8")).not.toContain("NYLORUN_IDENTITY_FILE");
    await writeFile(paths.identity, "issuers: []\n");
    await prepare(home);
    const compose = await readFile(paths.compose, "utf8");
    expect(compose).toBe(renderComposeFile("nylorun-shop", "shop", { identity: true }));
    const runtime = compose.slice(compose.indexOf("  runtime:"), compose.indexOf("  studio:"));
    expect(runtime).toContain("NYLORUN_IDENTITY_FILE: /nylorun/identity.yaml");
    // The runtime reads it through the Host root mount.
    expect(runtime).toContain("- ${NYLORUN_HOST_ROOT:?run nylorun start}:/nylorun # Host root");
  });

  it("avoids ports other Tenants keep for new ports only, and keeps derived principals", async () => {
    const home = await temporaryHome();
    const first = await prepare(home, fakePorts(), {
      reserved: [8787, 4161],
      derivedPrincipals: "babai",
    });
    expect(first.env).toMatchObject({ runtimePort: 50000, adminPort: 8788, studioPort: 50001 });
    expect(first.env.derivedPrincipals).toBe("project,babai");
    const second = await prepare(home, fakePorts(), { reserved: [50000, 8788] });
    expect(second.env).toMatchObject({ runtimePort: 50000, adminPort: 8788, studioPort: 50001 });
    expect(second.env.derivedPrincipals).toBe("project,babai");
  });

  it("persists ports and the password; refreshes images and UID", async () => {
    const home = await temporaryHome();
    const first = await prepare(home, fakePorts([8787]));
    expect(first.env.runtimePort).toBe(50000);
    const second = await prepare(home, fakePorts([50000, 4161, 9070]), {
      uid: 777,
      runtimeImage: "nylorun-runtime:dev",
    });
    expect(second.firstRun).toBe(false);
    expect(second.env.runtimePort).toBe(50000);
    expect(second.env.studioPort).toBe(4161);
    expect(second.env.restatePort).toBe(9070);
    expect(second.env.postgresPassword).toBe(first.env.postgresPassword);
    expect(second.env.gatesToken).toBe(first.env.gatesToken);
    expect(second.env.objectStoreSecretKey).toBe(first.env.objectStoreSecretKey);
    expect(first.env.harnessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(first.env.harnessToken).not.toBe(first.env.gatesToken);
    expect(second.env.harnessToken).toBe(first.env.harnessToken);
    expect(second.env.harness).toBe("remote");
    expect(second.env.restateIdentityKey).toBe(first.env.restateIdentityKey);
    expect(second.env.uid).toBe(777);
    expect(second.env.runtimeImage).toBe("nylorun-runtime:dev");
    expect(second.adminKey).toBe(first.adminKey);
    expect(second.host.hostId).toBe(first.host.hostId);
  });

  it("makes the harness container's directories and the plugins directory before Compose binds them", async () => {
    const home = await temporaryHome();
    await prepare(home, fakePorts());
    const paths = stackPaths(home);
    for (const dir of [...Object.values(paths.harness), paths.plugins])
      expect(await mode(dir)).toBe(0o700);
    expect(paths.plugins).toBe(`${paths.root}/plugins`);
  });

  it("keeps a launcher host.json's hostId and unknown fields, and fixes credential modes", async () => {
    const home = await temporaryHome();
    const paths = stackPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({ format: 1, hostId: "host_0123456789abcdefghjkmnpqrs", host: "127.0.0.1", port: 8787, proxy: { noProxy: "x" } }),
    );
    const adminKey = "ab".repeat(32);
    await writeFile(paths.credentials, JSON.stringify({ adminKey }), { mode: 0o644 });
    const prepared = await prepare(home);
    expect(prepared.adminKey).toBe(adminKey);
    expect(await mode(paths.credentials)).toBe(0o600);
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toMatchObject({
      hostId: "host_0123456789abcdefghjkmnpqrs",
      host: "localhost",
      proxy: { noProxy: "x" },
    });
  });

  it("keeps an existing identity key, fixes its mode and refuses a corrupt one", async () => {
    const home = await temporaryHome();
    const paths = stackPaths(home);
    await mkdir(paths.docker, { recursive: true });
    await writeFile(paths.restateIdentity, FIXED_PEM, { mode: 0o644 });
    const prepared = await prepare(home);
    expect(prepared.env.restateIdentityKey).toBe(FIXED_KEY);
    expect(await mode(paths.restateIdentity)).toBe(0o600);
    expect(await readFile(paths.restateIdentity, "utf8")).toBe(FIXED_PEM);

    await writeFile(paths.restateIdentity, "not a key");
    await expect(prepare(home)).rejects.toThrow(/restate-identity\.pem: .*Delete it/);
  });

  it("refuses a newer host.json format", async () => {
    const home = await temporaryHome();
    const paths = stackPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, JSON.stringify({ format: 2, hostId: "host_x", host: "h", port: 1 }));
    await expect(prepare(home)).rejects.toThrow(/format 2 .* newer/);
  });
});
