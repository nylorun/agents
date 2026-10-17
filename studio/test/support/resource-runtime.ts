/** Deterministic public HTTP fixture; no Studio-specific Runtime endpoints. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/agents";

export const TENANT = "tn_00000000000000000000000001";
export const SESSION = "s-resource";
/** A virtual Agent pinned to `analyst-box@2`; v3 is the latest. */
export const AGENT = "team/build";
/** A pod Agent tracking `pod-box`, with setup commands and an input file. */
export const POD = "team/pod";
/** An Agent pinned to `analyst-box@3`, whose session waits on a person: it sorts first. */
export const ASKING = "z-last";
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
const runtime = {
  resources: { cpus: 1, memory: "1024MiB" },
  network: { allowedHosts: ["pypi.org"] },
  harness: "nylorun",
  lifecycle: { idle: "15m" },
};
const agent = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  manifest: "analyst-box@2",
  resolvedVersion: 2,
  manifestHash: "m2",
  tracking: "pinned",
  targetVersion: null,
  waitingFor: null,
  failedVersion: null,
  startCheck: null,
  kind: "virtual",
  harness: "nylorun",
  owner: null,
  labels: { project: "build" },
  state: "sleeping",
  attention: [],
  desired: "on",
  compute: { state: "ready" },
  runtime,
  limits: {
    artifacts: { fileBytes: 1, totalBytes: 1 },
    skills: { totalBytes: 1 },
    disk: { versionBytes: 1, versionEntries: 1 },
  },
  sessions: [{ id: SESSION, ownerUserId: "alice", status: "idle", activeTurnId: null }],
  slots: [{ name: "github", type: "bearer", required: false, set: true }],
  disk: { latestVersion: null, operation: null },
  forkedFrom: null,
  lastUsedAt: time,
  createdAt: time,
  updatedAt: time,
  ...fields,
});
/** A saved agent manifest's versions: v3 is the latest. */
const analystBox = (version: number) => ({
  name: "analyst-box",
  version,
  hash: `m${version}`,
  manifest: {
    manifestSchemaVersion: 8,
    name: "analyst-box",
    description: "Answers questions about data.",
    harness: {
      instructions: ["Analyse the data."],
      mcpServers: { github: { name: "github", type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" } },
    },
    runtime: { kind: "virtual", network: { allowedHosts: ["pypi.org"] }, lifecycle: { idle: "15m" } },
  },
  savedBy: { actor: "application" },
  createdAt: time,
  agents: version === 2 ? 1 : version === 3 ? 1 : 0,
});
const asking = agent(ASKING, {
  manifest: "analyst-box@3",
  resolvedVersion: 3,
  tracking: "pinned",
  labels: { team: "data" },
  owner: "local-developer",
  state: "input_required",
  attention: [{ state: "input_required", sessionId: "s-ask", reason: "paused" }],
  sessions: [{ id: "s-ask", ownerUserId: "local-developer", status: "paused", activeTurnId: null }],
  lastUsedAt: "2026-09-01T00:00:00.000Z",
});
/** The folder artifact that holds `team/build`'s disk versions. */
const disk = {
  ...folder,
  artifactId: "a-disk",
  name: "disk",
  sessionId: undefined,
  agentId: AGENT,
};
/** A Tenant-owned file an application uploaded: a pod's input file. */
const input = {
  ...file,
  artifactId: INPUT_ARTIFACT,
  name: "requirements.txt",
  contentType: "text/plain",
  sessionId: undefined,
  latestVersion: 1,
  labels: { purpose: "input" },
  versions: [version(1, "text/plain")],
};
const pod = (id: string) =>
  agent(id, {
    manifest: "pod-box",
    resolvedVersion: 1,
    tracking: "tracking",
    kind: "pod",
    runtime: {
      image: "python:3.13-slim",
      resources: { cpus: 1, memory: "1024MiB" },
      storage: "5GiB",
      network: { allowedHosts: ["pypi.org"] },
      harness: "nylorun",
      lifecycle: { idle: "15m" },
      setup: [{ command: "pip install -r requirements.txt", cwd: "/workspace/app" }],
      files: [{ artifactId: INPUT_ARTIFACT, version: 1, path: "/workspace/data" }],
    },
    compute: {
      state: "running",
      pod: { desired: "running", observed: "running", volumeGeneration: 1, hostEpoch: 1 },
    },
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
  agentId: AGENT,
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

/** `artifactReads: false`: a Host without artifact pages. */
export async function resourceRuntime({ artifactReads = true } = {}) {
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
            ...(artifactReads ? ["artifact-reads"] : []),
          ],
        },
      });
    if (path === "/v1/tenant")
      return send(200, { tenant: { id: TENANT, name: "Resource fixture" } });
    if (path === "/v1/agents") return send(200, { agents: [agent(AGENT), asking, pod(POD)] });
    if (path === "/v1/agent-manifests")
      return send(200, { manifests: [analystBox(3), { ...analystBox(1), name: "pod-box", manifest: { ...analystBox(1).manifest, name: "pod-box" } }] });
    if (path === "/v1/agent-manifests/analyst-box") return send(200, analystBox(3));
    if (path === "/v1/agent-manifests/analyst-box/versions")
      return send(200, {
        name: "analyst-box",
        latest: 3,
        versions: [3, 2, 1].map((n) => {
          const { manifest: _, name: __, ...rest } = analystBox(n);
          return rest;
        }),
      });
    if (/^\/v1\/agent-manifests\/analyst-box\/versions\/[1-3]$/.test(path))
      return send(200, analystBox(Number(path.split("/")[5])));
    if (path.startsWith("/v1/agent-manifests/"))
      return send(404, { code: "manifest_not_found", message: "Agent manifest not found" });
    if (path === "/v1/agents/team%2Fbuild" && req.method === "GET")
      return send(
        200,
        agent(AGENT, {
          disk: { latestVersion: 2, operation: null },
          sessions: [
            { id: SESSION, ownerUserId: "alice", status: "idle", activeTurnId: null },
            { id: "s-other", ownerUserId: "bob", status: "running", activeTurnId: "t9" },
          ],
        }),
      );
    if (path === "/v1/agents/team%2Fpod" && req.method === "GET") return send(200, pod(POD));
    if (path === "/v1/agents/z-last" && req.method === "GET") return send(200, asking);
    if (path === "/v1/agents/team%2Fbuild/versions")
      return send(200, {
        agentId: AGENT,
        artifactId: disk.artifactId,
        latest: 2,
        versions: [
          { version: 2, bytes: 4096, createdAt: time },
          { version: 1, bytes: 2048, createdAt: time },
        ],
      });
    if (path === "/v1/agents/team%2Fbuild/snapshot" && req.method === "POST")
      return send(200, {
        agentId: AGENT,
        artifactId: disk.artifactId,
        version: 3,
        format: "nylorun.folder.v2",
        files: 12,
        bytes: 4096,
        storedBytes: 1024,
        durationMs: 40,
        unchanged: false,
        createdAt: time,
      });
    if (path === "/v1/agents/team%2Fbuild/restore" && req.method === "POST")
      return send(200, { agentId: AGENT, restored: JSON.parse(raw).version, status: "done" });
    if (/^\/v1\/agents\/team%2Fbuild\/versions\/\d+$/.test(path) && req.method === "DELETE")
      return send(200, { agentId: AGENT, version: Number(path.split("/")[5]), deleted: true });
    if (/^\/v1\/agents\/[^/]+\/fork$/.test(path) && req.method === "POST") {
      const body = JSON.parse(raw);
      const plan = {
        source: decodeURIComponent(path.split("/")[3]!),
        id: body.id,
        kind: "virtual",
        manifest: { name: "analyst-box", version: body.manifest === "analyst-box@3" ? 3 : 2 },
        disk: body.disk === "empty" ? null : body.disk,
        setup: false,
        secrets: { copied: body.secrets === "none" ? [] : ["github"], dropped: [], missing: [] },
        changes: body.manifest === "analyst-box@3" ? [{ path: "harness.instructions", from: [], to: [] }] : [],
        sessions: 2,
      };
      if (body.dryRun) return send(200, { dryRun: true, plan });
      return send(201, {
        agent: agent(body.id, {
          manifest: body.manifest ?? "analyst-box",
          resolvedVersion: plan.manifest.version,
          forkedFrom: { agent: plan.source, disk: typeof body.disk === "number" ? body.disk : 2 },
          sessions: [],
        }),
        plan: { ...plan, disk: typeof body.disk === "number" ? body.disk : 2 },
      });
    }
    if (/^\/v1\/agents\/[^/]+$/.test(path) && req.method === "PUT") {
      const body = JSON.parse(raw);
      const id = decodeURIComponent(path.split("/")[3]!);
      const at = body.manifest.lastIndexOf("@");
      return send(
        200,
        agent(id, {
          manifest: body.manifest,
          resolvedVersion: at > 0 ? Number(body.manifest.slice(at + 1)) : 3,
          tracking: at > 0 ? "pinned" : "tracking",
          labels: body.labels ?? {},
          owner: body.owner ?? null,
          sessions: [],
        }),
      );
    }
    // Any other Agent Studio created reads back as a fresh virtual one.
    if (/^\/v1\/agents\/[^/]+$/.test(path) && req.method === "GET" && !path.endsWith("/missing"))
      return send(200, agent(decodeURIComponent(path.split("/")[3]!), { sessions: [] }));
    if (/^\/v1\/agents\/[^/]+$/.test(path) && req.method === "DELETE")
      return send(200, { id: decodeURIComponent(path.split("/")[3]!), deleted: true });
    if (path === "/v1/agents/team%2Fbuild/secrets") return send(200, { secrets: [secret] });
    if (/^\/v1\/agents\/team%2Fbuild\/secrets\/[^/]+$/.test(path) && req.method === "PUT") {
      const body = JSON.parse(raw);
      return send(200, {
        name: decodeURIComponent(path.split("/")[5]!),
        type: body.type,
        binding: body.url ? { url: body.url } : body.allowedHosts ? { allowedHosts: body.allowedHosts } : {},
        createdAt: time,
      });
    }
    if (/^\/v1\/agents\/[^/]+\/secrets$/.test(path)) return send(200, { secrets: [] });
    if (path === "/v1/agents/team%2Fbuild/events") {
      const seq = refreshes++;
      return send(200, {
        events: [
          {
            schema: "nylorun.agent-event/1",
            eventId: `agent_${seq}`,
            tenantId: TENANT,
            agentId: AGENT,
            seq,
            time,
            type: seq === 0 ? "agent.created" : "agent.attached",
            payload: {},
          },
        ],
      });
    }
    if (path.startsWith("/v1/agents/"))
      return send(404, { code: "not_found", message: "Agent not found" });
    if (path === "/v1/sessions")
      return send(
        200,
        url.searchParams.has("limit")
          ? {
              sessions: [
                {
                  ...summary,
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
        manifest: { name: "analyst-box", version: 2 },
        manifestHash: "h",
        harness: "nylorun",
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
        agentId: AGENT,
        definition: { name: "analyst-box", version: 2 },
        manifest: { manifestSchemaVersion: 7, id: "analyst-box", instructions: ["Analyse the data."] },
        manifestHash: "h",
      });
    if (path === "/v1/artifacts" && url.searchParams.has("limit")) {
      // Newest first; page 2 holds the oldest. Filters as the Runtime applies them.
      const sessionFilter = url.searchParams.get("sessionId");
      const kindFilter = url.searchParams.get("kind");
      const labelFilters = url.searchParams.getAll("label");
      const all = [input, disk, folder, file]
        .filter((a) => sessionFilter === null || a.sessionId === sessionFilter)
        .filter((a) => kindFilter === null || a.kind === kindFilter)
        .filter((a) =>
          labelFilters.every((l) => {
            const [k, v] = [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)];
            return (a as { labels?: Record<string, string> }).labels?.[k] === v;
          }),
        )
        .map(({ versions: _, ...a }) => a);
      const second = url.searchParams.get("cursor") === "artifacts2";
      const items = second ? all.slice(3) : all.slice(0, 3);
      return send(200, {
        artifacts: items,
        nextCursor: !second && all.length > 3 ? "artifacts2" : null,
      });
    }
    if (path === "/v1/artifacts")
      return send(200, {
        artifacts: [file, folder].map(({ versions: _, ...a }) => a),
      });
    if (path === "/v1/artifacts/a-report") return send(200, file);
    if (path === "/v1/artifacts/a-disk") return send(200, disk);
    if (path === `/v1/artifacts/${INPUT_ARTIFACT}`) return send(200, input);
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
      const { agentId } = JSON.parse(raw);
      return send(200, {
        agentId,
        complete: true,
        entries: [
          {
            kind: "mcp",
            name: "github",
            serverName: "github",
            url: "https://api.githubcopilot.com/mcp/",
            required: false,
            status: "covered",
            credential: { agentId, name: "github" },
            message: "Sends the Agent's github credential.",
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
