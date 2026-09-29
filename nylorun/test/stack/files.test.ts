import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderComposeFile } from "../../src/stack/compose-file.js";
import {
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
  studioPort: 4161,
  restatePort: 9070,
  postgresPassword: "0123456789abcdef0123456789abcdef0123456789abcdef",
  restateIdentityKey: "publickeyv1_CgojDdtCBsK8zYsbqruLmwXgWqMYxDfu3n5qJdcJeNtv",
  uid: 501,
  gid: 20,
  hostRoot: "/Users/dev/.nylorun",
  runtimeImage: "ghcr.io/nylorun/runtime:0.10.0-beta",
  studioImage: "ghcr.io/nylorun/studio:0.9.0-beta",
  sandbox: "virtual",
  openshellPort: 18080,
  openshellHealthPort: 18081,
  openshellTelemetry: true,
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
  const compose = renderComposeFile();

  it("matches the committed file", () => {
    expect(compose).toMatchSnapshot();
  });

  it("publishes the Runtime, Studio, Restate UI and the optional OpenShell gateway, all on loopback", () => {
    const published = [...compose.matchAll(/^\s+- "([^"]+):([^":]+)"/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect(published).toEqual([
      "127.0.0.1:${NYLORUN_RESTATE_PORT:?run nylorun start}:9070",
      "127.0.0.1:${NYLORUN_PORT:?run nylorun start}:4000",
      "127.0.0.1:${NYLORUN_OPENSHELL_PORT:-18080}:${NYLORUN_OPENSHELL_PORT:-18080}",
      "127.0.0.1:${NYLORUN_OPENSHELL_HEALTH_PORT:-18081}:8081",
      "127.0.0.1:${NYLORUN_STUDIO_PORT:?run nylorun start}:3000",
    ]);
    // The gateway runs only with the openshell profile.
    expect(compose).toContain('profiles: ["openshell"]');
  });

  it("pins Postgres, Restate and s2 and takes the Runtime and Studio images from .env", () => {
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

  it("keeps s2-lite's data in a volume its non-root user can write", () => {
    expect(compose).toContain('command: ["lite", "--local-root", "/home/nonroot/data"]');
    expect(compose).toContain("- s2:/home/nonroot\n");
  });

  it("mounts the Restate identity key read-only into Restate and gives the Runtime its public key", () => {
    expect(compose).toContain(
      "RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE: /run/nylorun/restate-identity.pem",
    );
    expect(compose).toContain(
      "- ${NYLORUN_HOST_ROOT:?run nylorun start}/stack/restate-identity.pem:/run/nylorun/restate-identity.pem:ro",
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
      studioPort: 4161,
      restatePort: 9070,
      postgresPassword: env.postgresPassword,
      sandbox: "virtual",
      openshellPort: 18080,
      openshellHealthPort: 18081,
      openshellTelemetry: true,
    });
  });

  it("quotes paths with spaces and refuses single quotes", () => {
    const text = renderEnvFile({ ...env, hostRoot: "/Users/A Dev/.nylorun" });
    expect(text).toContain("NYLORUN_HOST_ROOT='/Users/A Dev/.nylorun'");
    expect(parseEnvLines(text).get("NYLORUN_HOST_ROOT")).toBe("/Users/A Dev/.nylorun");
    expect(() => renderEnvFile({ ...env, hostRoot: "/it's" })).toThrow(/single quote/);
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
  const prepare = (home: string, ports = fakePorts(), overrides: { uid?: number; runtimeImage?: string } = {}) =>
    prepareStack({
      paths: stackPaths(home),
      images: { ...images, ...(overrides.runtimeImage ? { runtime: overrides.runtimeImage } : {}) },
      uid: overrides.uid ?? 501,
      gid: 20,
      runtimeVersion: "0.10.0-beta",
      ports,
      project: "nylorun",
    });

  it("writes host.json, credentials, compose.yaml and .env with the right modes", async () => {
    const home = await temporaryHome();
    const paths = stackPaths(home);
    const prepared = await prepare(home);
    expect(prepared.firstRun).toBe(true);
    expect(prepared.env).toMatchObject({ runtimePort: 8787, studioPort: 4161, restatePort: 9070, uid: 501, gid: 20, hostRoot: paths.root });
    expect(prepared.env.postgresPassword).toMatch(/^[0-9a-f]{48}$/);
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
      runtimeVersion: "0.10.0-beta",
    });
    const credentials = JSON.parse(await readFile(paths.credentials, "utf8"));
    expect(credentials).toEqual({ adminKey: prepared.adminKey });
    expect(prepared.adminKey).toMatch(/^[0-9a-f]{64}$/);

    expect(await mode(paths.credentials)).toBe(0o600);
    expect(await mode(paths.env)).toBe(0o600);
    expect(await mode(paths.config)).toBe(0o600);
    expect(await mode(paths.root)).toBe(0o700);
    expect(await mode(paths.stack)).toBe(0o700);
    expect(await readFile(paths.compose, "utf8")).toBe(renderComposeFile());
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
    expect(second.env.restateIdentityKey).toBe(first.env.restateIdentityKey);
    expect(second.env.uid).toBe(777);
    expect(second.env.runtimeImage).toBe("nylorun-runtime:dev");
    expect(second.adminKey).toBe(first.adminKey);
    expect(second.host.hostId).toBe(first.host.hostId);
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
    await mkdir(paths.stack, { recursive: true });
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
