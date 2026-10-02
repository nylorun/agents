import { expect, it } from "vitest";
import {
  HealthResponseSchema,
  ReadyResponseSchema,
} from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../src/host/create-host.js";
import { createHostLogger } from "../../src/host/logger.js";
import { RUNTIME_VERSION } from "../../src/version.js";
import {
  ADMIN_KEY,
  createFakeModule,
  freePort,
  getJson,
  startTestHost,
} from "./support.js";

it("C2: /health reports hostId, protocol, coreVersion and pid without auth", async () => {
  const { url, config } = await startTestHost();
  const { status, body } = await getJson(`${url}/health`);
  expect(status).toBe(200);
  const parsed = HealthResponseSchema.parse(body);
  expect(parsed.status).toBe("ok");
  expect(parsed.service).toBe("nylorun-runtime");
  expect(parsed.version).toBe(RUNTIME_VERSION);
  expect(parsed.hostId).toBe(config.hostId);
  expect(parsed.coreVersion).toBe("0.4.0-beta");
  expect(parsed.pid).toBe(process.pid);
  expect(parsed.protocol).toEqual({
    min: HOST_PROTOCOL.min,
    max: HOST_PROTOCOL.max,
    features: [...HOST_PROTOCOL.features],
  });
  expect(parsed).not.toHaveProperty("scopeId");
});

it("C2: /ready is 200 after listen once the Tenant is open", async () => {
  const { url } = await startTestHost();
  const ready = await getJson(`${url}/ready`);
  expect(ready.status).toBe(200);
  ReadyResponseSchema.parse(ready.body);
  expect(ready.body).toMatchObject({
    status: "ready",
    checks: { listener: true, tenant: true },
  });
});

it("C2: /ready is 503 while the Tenant could not be opened", async () => {
  const { url } = await startTestHost({
    module: createFakeModule({
      tenant: {
        state: "unavailable",
        cause: { code: "kek-missing", message: "vault key missing", repair: "restore it" },
      },
    }),
  });
  const ready = await getJson(`${url}/ready`);
  expect(ready.status).toBe(503);
  expect(ready.body).toMatchObject({
    status: "not_ready",
    checks: { listener: true, tenant: false },
  });
});

it("C2: /ready is 503 while the Tenant opens", async () => {
  let finishStart!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const mod = createFakeModule({ onStart: () => blocked });

  const root = await mkdtemp(join(tmpdir(), "nylorun-ready-"));
  const port = await freePort();
  await mkdir(join(root, "home"), { recursive: true });
  const config = {
    hostId: "host_0123456789abcdefghjkmnpq",
    host: "127.0.0.1",
    port,
  };
  await writeFile(join(root, "host.json"), JSON.stringify(config));
  await writeFile(
    join(root, "host-credentials.json"),
    JSON.stringify({ adminKey: ADMIN_KEY }),
  );

  const host = createHost({
    hostRoot: root,
    module: mod,
    config,
    credentials: { adminKey: ADMIN_KEY },
    logger: createHostLogger(() => {}),
    coreVersion: "0.4.0-beta",
  });

  const listening = host.listen();
  // url is assigned after bind, before start() resolves
  for (let i = 0; i < 50 && !host.url; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(host.url).toMatch(/^http:\/\//);

  const notReady = await getJson(`${host.url}/ready`);
  expect(notReady.status).toBe(503);
  expect(notReady.body).toMatchObject({
    status: "not_ready",
    checks: { listener: true, tenant: false },
  });

  finishStart();
  await listening;
  const ready = await getJson(`${host.url}/ready`);
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({
    status: "ready",
    checks: { listener: true, tenant: true },
  });
  await host.close();
  await rm(root, { recursive: true, force: true });
});
