import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
} from "@nylorun/core/compatibility";

export const ADMIN_KEY = "a".repeat(64);
export const APPLICATION_KEY = "b".repeat(64);
export const MANAGEMENT_KEY = "d".repeat(64);

export function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: { ...HOST_PROTOCOL, features: [...PROTOCOL_FEATURES] },
    coreVersion: "0.4.0-beta",
    hostId: "host_00000000000000000000000001",
    pid: 1,
    ...overrides,
  };
}

export type RecordedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

export async function startStubServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
    recorded: RecordedRequest[],
  ) => void | Promise<void>,
): Promise<{
  url: string;
  close(): Promise<void>;
  recorded: RecordedRequest[];
}> {
  const recorded: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      recorded.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      });
      void Promise.resolve(handler(request, response, body, recorded)).catch(
        (error) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              status: "rejected",
              code: "not_found",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    recorded,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/**
 * A local Host root: `host.json`, `host-credentials.json` (the admin key) and, unless
 * `credentialsFile` is null, a credentials file holding `managementKey` (mode 0600, or
 * `credentialsMode`).
 */
export async function writeLocalHost(options: {
  host?: string;
  port: number;
  format?: 0 | 1;
  managementKey?: string;
  credentialsFile?: "project-credentials.json" | "cli-credentials.json" | null;
  credentialsMode?: number;
}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nylorun-admin-"));
  const hostJson: Record<string, unknown> = {
    hostId: "host_00000000000000000000000001",
    host: options.host ?? "127.0.0.1",
    port: options.port,
  };
  if (options.format !== undefined) hostJson.format = options.format;
  await writeFile(join(home, "host.json"), `${JSON.stringify(hostJson)}\n`, { mode: 0o600 });
  await writeFile(join(home, "host-credentials.json"), `${JSON.stringify({ adminKey: ADMIN_KEY })}\n`, {
    mode: 0o600,
  });
  const file = options.credentialsFile === undefined ? "project-credentials.json" : options.credentialsFile;
  if (file !== null) await writeCredentials(join(home, file), options.managementKey ?? MANAGEMENT_KEY, options.credentialsMode);
  return home;
}

/** A credentials file (format 1) with an application and a management key. */
export async function writeCredentials(path: string, managementKey: string, mode?: number): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ format: 1, applicationKey: APPLICATION_KEY, principalId: "project", managementKey, managementPrincipalId: "project-management" })}\n`,
    { mode: 0o600 },
  );
  if (mode !== undefined) await chmod(path, mode);
}

export function sampleEnvelope(id = "tn_00000000000000000000000001") {
  return {
    id,
    name: "demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
  };
}

/** `GET /v1/tenant`'s answer, as far as these tests read it. */
export function sampleTenantStatus() {
  return { tenant: sampleEnvelope() };
}
