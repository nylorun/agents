/** Deterministic public HTTP fixture; no Studio-specific Runtime endpoints. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/agents";

export const TENANT = "tn_00000000000000000000000001";
export const SESSION = "s-resource";
export const ENVIRONMENT = "team/build";
/** A pod Environment with setup commands and an input file. */
export const POD = "team/pod";
export const INPUT_ARTIFACT = "af_01k7aaaaaaaaaaaaaaaaaaaaaa";
const time = "2026-10-10T00:00:00.000Z";
const html =
  "<h1>Report version 1</h1><script>window.previewExecuted=true</script>";
const text = "Report version 2";
const version = (n: number, contentType = "text/html") => ({
  version: n,
  size: n === 1 ? Buffer.byteLength(html) : Buffer.byteLength(text),
  contentType,
  sha256: "a".repeat(64),
  source: "upload",
  createdAt: time,
});
const file = {
  artifactId: "a-report",
  kind: "file",
  name: "report.html",
  contentType: "text/html",
  sessionId: SESSION,
  latestVersion: 2,
  createdAt: time,
  updatedAt: time,
  versions: [version(1), version(2)],
};
const folder = {
  ...file,
  artifactId: "a-folder",
  kind: "folder",
  name: "outputs",
  contentType: "application/vnd.nylorun.folder+json",
  versions: [version(1), version(2)],
};
const entry = {
  path: "nested/a +b.html",
  size: Buffer.byteLength(html),
  contentType: "text/html",
  sha256: "b".repeat(64),
};
const environment = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  kind: "virtual",
  labels: { project: "build" },
  recipe: {
    resources: { cpus: 1, memory: "1024MiB" },
    network: { allowedHosts: ["pypi.org"] },
    harness: "nylorun",
    lifecycle: { idle: "15m" },
  },
  version: 2,
  appliedVersion: 2,
  ownerUserId: null,
  state: "stopped",
  lastUsedAt: time,
  sessions: [{ id: SESSION, activeTurnId: null }],
  createdAt: time,
  updatedAt: time,
  ...fields,
});
/** The folder artifact that holds `team/build`'s disk versions. */
const disk = {
  ...folder,
  artifactId: "a-disk",
  name: "disk",
  sessionId: undefined,
};
const pod = (id: string) =>
  environment(id, {
    kind: "pod",
    recipe: {
      image: "python:3.13-slim",
      resources: { cpus: 1, memory: "1024MiB" },
      storage: "5GiB",
      network: { allowedHosts: ["pypi.org"] },
      harness: "nylorun",
      lifecycle: { idle: "15m" },
      setup: [{ command: "pip install -r requirements.txt", cwd: "/workspace/app" }],
      files: [{ artifactId: INPUT_ARTIFACT, version: 1, path: "/workspace/data" }],
    },
    state: "running",
    pod: { desired: "running", observed: "running", volumeGeneration: 1, hostEpoch: 1 },
    disk: { latestVersion: null },
    sessions: [],
  });
const secret = {
  name: "github",
  type: "bearer",
  binding: { url: "https://api.githubcopilot.com/mcp/" },
  createdAt: time,
};
const summary = {
  id: SESSION,
  agentId: "external-agent",
  ownerUserId: "alice",
  status: "idle",
  activeTurnId: null,
};
const event = {
  schema: "nylorun.event/2",
  eventId: "ev_artifact",
  tenantId: TENANT,
  sessionId: SESSION,
  runId: null,
  turnId: "t1",
  incarnation: 0,
  epoch: 0,
  seq: 0,
  cursor: "c0",
  time,
  schemaVersion: 1,
  source: { kind: "loop", id: "fixture" },
  evidence: "observed",
  visibility: "public",
  retention: "full",
  type: "artifact.version.created",
  payload: { artifactId: file.artifactId, version: 1, name: file.name },
};

export async function resourceRuntime() {
  const requests: {
    method: string;
    path: string;
    body: unknown;
    range?: string;
  }[] = [];
  let refreshes = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname;
    requests.push({
      method: req.method!,
      path: req.url!,
      body: raw ? JSON.parse(raw) : undefined,
      range: req.headers.range,
    });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health")
      return send(200, {
        status: "ok",
        protocol: {
          min: PROTOCOL_VERSION,
          max: PROTOCOL_VERSION,
          features: [
            ...PROTOCOL_FEATURES,
            "session-reads",
            "environment-setup",
            "environment-disk-versions",
          ],
        },
      });
    if (path === "/v1/tenant")
      return send(200, { tenant: { id: TENANT, name: "Resource fixture" } });
    if (path === "/v1/agents") return send(200, { agents: [] });
    if (path === "/v1/environments")
      return send(200, {
        environments: url.searchParams.has("limit")
          ? [environment(url.searchParams.has("cursor") ? "z-last" : ENVIRONMENT)]
          : [environment(ENVIRONMENT)],
        ...(url.searchParams.has("limit")
          ? {
              nextCursor:
                url.searchParams.has("cursor") || url.searchParams.has("label")
                  ? null
                  : "page2",
            }
          : {}),
      });
    if (path === "/v1/environments/team%2Fbuild" && req.method === "GET")
      return send(
        200,
        environment(ENVIRONMENT, {
          disk: { latestVersion: 2 },
          sessions: [
            { id: SESSION, activeTurnId: null },
            { id: "s-other", activeTurnId: "t9" },
          ],
        }),
      );
    if (path === "/v1/environments/team%2Fpod" && req.method === "GET")
      return send(200, pod(POD));
    if (path === "/v1/environments/team%2Fbuild/versions")
      return send(200, {
        environmentId: ENVIRONMENT,
        artifactId: disk.artifactId,
        latest: 2,
        versions: [
          { version: 2, bytes: 4096, createdAt: time },
          { version: 1, bytes: 2048, createdAt: time },
        ],
      });
    if (path === "/v1/environments/team%2Fbuild/snapshot" && req.method === "POST")
      return send(200, {
        environmentId: ENVIRONMENT,
        artifactId: disk.artifactId,
        version: 3,
        format: "nylorun.folder.v2",
        files: 12,
        bytes: 4096,
        storedBytes: 1024,
        durationMs: 40,
        unchanged: false,
      });
    if (path === "/v1/environments/team%2Fbuild/restore" && req.method === "POST")
      return send(200, {
        environmentId: ENVIRONMENT,
        restored: JSON.parse(raw).version,
        status: "done",
      });
    if (/^\/v1\/environments\/team%2Fbuild\/versions\/\d+$/.test(path) && req.method === "DELETE")
      return send(200, {
        environmentId: ENVIRONMENT,
        version: Number(path.split("/")[5]),
        deleted: true,
      });
    if (/^\/v1\/environments\/[^/]+$/.test(path) && req.method === "PUT") {
      const body = JSON.parse(raw);
      const id = decodeURIComponent(path.split("/")[3]!);
      return send(
        200,
        environment(id, {
          kind: body.kind ?? "virtual",
          labels: body.labels ?? {},
          ownerUserId: body.ownerUserId ?? null,
          version: id === ENVIRONMENT ? 3 : 1,
          appliedVersion: id === ENVIRONMENT ? 3 : 1,
          sessions: [],
        }),
      );
    }
    // Any other Environment Studio created reads back as a fresh virtual one.
    if (/^\/v1\/environments\/[^/]+$/.test(path) && req.method === "GET" && !path.endsWith("/missing"))
      return send(200, environment(decodeURIComponent(path.split("/")[3]!), { sessions: [] }));
    if (/^\/v1\/environments\/[^/]+$/.test(path) && req.method === "DELETE")
      return send(200, { id: decodeURIComponent(path.split("/")[3]!), deleted: true });
    if (path === "/v1/environments/team%2Fbuild/secrets")
      return send(200, { secrets: [secret] });
    if (/^\/v1\/environments\/team%2Fbuild\/secrets\/[^/]+$/.test(path) && req.method === "PUT") {
      const body = JSON.parse(raw);
      return send(200, {
        name: decodeURIComponent(path.split("/")[5]!),
        type: body.type,
        binding: body.url
          ? { url: body.url }
          : body.allowedHosts
            ? { allowedHosts: body.allowedHosts }
            : {},
        createdAt: time,
      });
    }
    if (path === "/v1/environments/team%2Fbuild/events") {
      const seq = refreshes++;
      return send(200, {
        events: [
          {
            schema: "nylorun.environment-event/1",
            eventId: `env_${seq}`,
            tenantId: TENANT,
            environmentId: ENVIRONMENT,
            seq,
            time,
            type: seq === 0 ? "environment.created" : "environment.attached",
            payload: {},
          },
        ],
      });
    }
    if (path.startsWith("/v1/environments/"))
      return send(404, { code: "not_found", message: "Environment not found" });
    if (path === "/v1/sessions")
      return send(
        200,
        url.searchParams.has("limit")
          ? {
              sessions: [
                {
                  ...summary,
                  environmentId: ENVIRONMENT,
                  createdAt: time,
                  lastEventAt: time,
                  lastTurnId: "t1",
                },
              ],
              nextCursor: null,
            }
          : { sessions: [summary] },
      );
    if (path === `/v1/sessions/${SESSION}`)
      return send(200, {
        ...summary,
        manifestHash: "h",
        implementationVersion: "1",
        environment: { id: ENVIRONMENT, version: 2 },
        mcpSnapshot: null,
        mcpDiagnostics: [],
        uncertainEffects: [],
      });
    if (path === `/v1/sessions/${SESSION}/items`)
      return send(200, { items: [event], cursor: "c0" });
    if (path === `/v1/sessions/${SESSION}/events`) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    if (path === `/v1/sessions/${SESSION}/manifest`)
      return send(200, {
        sessionId: SESSION,
        agentId: "external-agent",
        manifest: { id: "external-agent" },
        manifestHash: "h",
        implementationVersion: "1",
      });
    if (path === "/v1/artifacts")
      return send(200, {
        artifacts: [file, folder].map(({ versions: _, ...a }) => a),
      });
    if (path === "/v1/artifacts/a-report") return send(200, file);
    if (path === "/v1/artifacts/a-disk") return send(200, disk);
    if (path === "/v1/artifacts/a-folder") return send(200, folder);
    if (path === "/v1/artifacts/a-slow") {
      setTimeout(() => {
        if (!res.destroyed)
          send(200, { ...file, artifactId: "a-slow", name: "Stale report" });
      }, 250);
      return;
    }
    if (/^\/v1\/artifacts\/(a-report|a-folder)\/links$/.test(path)) {
      const body = JSON.parse(raw);
      return send(200, {
        path: `/v1/artifact-links/v${body.version}`,
        artifactId: path.split("/")[3],
        version: body.version,
        expiresAt: time,
      });
    }
    if (/^\/v1\/artifact-links\/v\d+$/.test(path)) {
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, {
        "content-type": "text/html",
        "content-disposition": 'attachment; filename="report.html"',
      });
      return res.end(html);
    }
    if (path.endsWith("/tree"))
      return send(200, {
        artifactId: "a-folder",
        version: Number(path.split("/")[5]),
        entries: [entry],
      });
    if (path.endsWith("/diff"))
      return send(200, {
        artifactId: "a-folder",
        from: 1,
        to: 2,
        added: [entry],
        removed: [],
        changed: [],
      });
    if (path.endsWith("/content") || path.includes("/files/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(path.includes("/versions/1/") ? html : text);
    }
    if (path.startsWith("/v1/artifacts/"))
      return send(404, { code: "not_found", message: "Artifact not found" });
    if (path === "/v1/tenant/providers" || path === "/v1/tenant/models")
      return send(200, { providers: [] });
    if (path === "/v1/tenant/model") return send(200, { configured: false });
    if (path === "/v1/tenant/credential-coverage" && req.method === "POST") {
      const { agentId, environmentId } = JSON.parse(raw);
      return send(200, {
        agentId,
        environmentId: environmentId ?? null,
        complete: environmentId !== undefined,
        entries: [
          {
            kind: "mcp",
            name: "github",
            serverName: "github",
            url: "https://api.githubcopilot.com/mcp/",
            required: false,
            status: environmentId ? "covered" : "missing",
            ...(environmentId ? { credential: { environmentId, name: "github" } } : {}),
            message: environmentId
              ? "Sends the Environment's github credential."
              : "Called without a credential.",
          },
        ],
      });
    }
    return send(404, { code: "not_found", message: "Unknown fixture API" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
