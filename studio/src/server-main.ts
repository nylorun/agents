#!/usr/bin/env node
/**
 * Container entry for the Studio server (`node dist/server-main.js`).
 *
 * Environment:
 * - `NYLORUN_RUNTIME_URL` (required): the Runtime, e.g. `http://runtime:4000`.
 * - `NYLORUN_ADMIN_KEY_FILE` (required): `host-credentials.json` with `{ adminKey }`.
 * - `PORT` (default 3000): listen port inside the container.
 * - `NYLORUN_STUDIO_PUBLIC_PORT` (default `PORT`): the published loopback port
 *   the browser uses; the `Host` check accepts only `localhost` and
 *   `127.0.0.1` on it.
 */
import {
  parseRuntimeUrl,
  readAdminKeyFile,
  startStudioServer,
} from "./server.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || value < 1 || value > 65535)
    throw new Error(`${name} must be a port number 1–65535.`);
  return value;
}

try {
  const runtimeUrl = parseRuntimeUrl(required("NYLORUN_RUNTIME_URL"));
  const adminKey = readAdminKeyFile(required("NYLORUN_ADMIN_KEY_FILE"));
  const listenPort = port("PORT", 3000);
  const publicPort = port("NYLORUN_STUDIO_PUBLIC_PORT", listenPort);
  const studio = await startStudioServer({
    runtimeUrl,
    adminKey,
    host: "0.0.0.0",
    port: listenPort,
    publicPort,
  });
  console.log(
    `Studio listening on 0.0.0.0:${studio.port}; browser URL ${studio.url}; Runtime ${runtimeUrl}`,
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      studio.close().finally(() => process.exit(0));
    });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
