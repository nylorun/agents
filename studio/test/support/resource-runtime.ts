/** Deterministic public HTTP fixture; no Studio-specific Runtime endpoints. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION, RUNTIME_LIMIT_DEFAULTS } from "@nylorun/agents";
import { tenantStatus } from "./tenant-status.ts";

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
/** A flow agent's manifest, saved once: its harness is a workflow (not in the list, opened by name). */
const digest = {
  name: "digest",
  version: 1,
  hash: "d1",
  manifest: {
    manifestSchemaVersion: 8,
    name: "digest",
    harness: {
      kind: "workflow",
      workflowSchemaVersion: 3,
      root: { chain: [{ agent: "fetch" }, { tool: { name: "file_report" } }] },
      agents: { fetch: { manifestSchemaVersion: 7, id: "fetch", instructions: ["Read the source."] } },
    },
  },
  savedBy: { actor: "application" },
  createdAt: time,
  agents: 0,
};
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
    runtime: {
      kind: "virtual",
      network: { allowedHosts: ["pypi.org"] },
      lifecycle: { idle: "15m" },
      triggers: { "weekly-kpi": { schedule: "0 8 * * 1", timezone: "Europe/Berlin", session: "kpi", prompt: "Write the weekly KPI digest." } },
    },
  },
  savedBy: { actor: "application" },
  createdAt: time,
  agents: version === 2 ? 1 : version === 3 ? 1 : 0,
  // v1 was saved as JSON; v2 and v3 from an agent folder (track T6).
  ...(version === 1 ? {} : { source: { compiler: "agent-folder/1", ...sourceSize(version) } }),
});
/** The agent folder analyst-box v2 and v3 were saved from: v3 changed AGENT.md and added a skill. */
export const SOURCE_AGENT_MD = "---\nname: analyst-box\ndescription: Answers questions about data.\n---\nAnalyse the data.\n";
const sourceEntries = (version: number) => [
  { path: "AGENT.md", size: Buffer.byteLength(SOURCE_AGENT_MD), sha256: version === 3 ? "3".repeat(64) : "2".repeat(64) },
  { path: "files/logo.png", size: 4, sha256: "4".repeat(64) },
  { path: "mcp.json", size: 20, sha256: "5".repeat(64) },
  ...(version === 3 ? [{ path: "skills/sql/SKILL.md", size: 30, sha256: "6".repeat(64) }] : [{ path: "README.md", size: 9, sha256: "7".repeat(64) }]),
];
const sourceSize = (version: number) => ({
  files: sourceEntries(version).length,
  bytes: sourceEntries(version).reduce((sum, entry) => sum + entry.size, 0),
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

const trigger = (status: string) => ({
  id: "weekly-kpi",
  kind: "schedule",
  status,
  pausedReason: status === "paused" ? "manual" : null,
  schedule: "0 8 * * 1",
  timezone: "Europe/Berlin",
  session: "kpi",
  nextRunAt: status === "active" ? "2026-10-12T06:00:00.000Z" : null,
  lastRunAt: time,
});
const run = {
  id: "run-1",
  triggerId: "weekly-kpi",
  kind: "schedule",
  dueAt: time,
  firedAt: time,
  late: false,
  status: "started",
  reason: null,
  sessionId: SESSION,
  turnId: "t1",
  queuedMessageId: null,
};
const memoryVersion = {
  id: "mv1",
  path: "conventions/release.md",
  fromPath: null,
  operation: "create",
  bytes: 24,
  contentSha256: "c".repeat(64),
  actor: "agent:analyst-box@2",
  sessionId: SESSION,
  turnId: "t1",
  triggerRunId: null,
  createdAt: time,
};

/** `artifactReads: false`: a Host without artifact pages. */
export async function resourceRuntime({ artifactReads = true } = {}) {
  const requests: {
    method: string;
    path: string;
    body: unknown;
    range?: string;
    ifMatch?: string;
  }[] = [];
  let refreshes = 0;
  let triggerStatus = "active";
  // The Tenant's settings, as its page reads and changes them.
  let toolRules: unknown[] = [
    { effect: "deny", server: "github", tool: "delete_repository", reason: "Repositories are deleted by people" },
  ];
  let budgets: unknown[] = [{ scope: "tenant", period: "month", limitUsd: 250 }];
  let limitOverrides: Record<string, number> = { modelAttempts: 5 };
  const MiB = 1024 ** 2;
  let sandboxConfig = {
    limits: {
      network: ["pypi.org", "github.com"],
      resources: { cpus: 4, memoryMiB: 8192 },
      defaultResources: { cpus: 1, memoryMiB: 1024 },
      idle: "15m",
      environments: 100,
    },
    lifecycle: { stopGrace: "10s" },
  };
  let memories = [
    {
      path: "conventions/release.md",
      bytes: 24,
      contentSha256: "c".repeat(64),
      description: "How releases are named",
      version: 1,
      updatedAt: time,
      content: "Releases are named vN.\n",
    },
  ];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname;
    requests.push({
      method: req.method!,
      path: req.url!,
      // A definition file's bytes are not JSON.
      body: raw ? (/json/.test(req.headers["content-type"] ?? "") ? JSON.parse(raw) : raw) : undefined,
      range: req.headers.range,
      ...(req.headers["if-match"] === undefined ? {} : { ifMatch: String(req.headers["if-match"]) }),
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
    if (path === "/v1/tenant") return send(200, tenantStatus(TENANT, "Resource fixture", [AGENT, ASKING, POD]));
    if (path === "/v1/agents") return send(200, { agents: [agent(AGENT), asking, pod(POD)] });
    if (path === "/v1/agent-manifests")
      return send(200, { manifests: [analystBox(3), { ...analystBox(1), name: "pod-box", manifest: { ...analystBox(1).manifest, name: "pod-box" } }] });
    if (path === "/v1/agent-manifests/analyst-box") return send(200, analystBox(3));
    if (path === "/v1/agent-manifests/digest" || path === "/v1/agent-manifests/digest/versions/1") return send(200, digest);
    if (path === "/v1/agent-manifests/digest/versions") {
      const { manifest: _, name: __, ...rest } = digest;
      return send(200, { name: "digest", latest: 1, versions: [rest] });
    }
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
    if (/^\/v1\/agent-manifests\/analyst-box\/versions\/[23]\/source$/.test(path)) {
      const n = Number(path.split("/")[5]);
      return send(200, { name: "analyst-box", version: n, compiler: "agent-folder/1", ...sourceSize(n), entries: sourceEntries(n) });
    }
    if (path === "/v1/agent-manifests/analyst-box/versions/3/source/files/AGENT.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      return res.end(SOURCE_AGENT_MD);
    }
    if (path === "/v1/agent-manifests/analyst-box/versions/3/source/files/files%2Flogo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x00]));
    }
    if (path === "/v1/agent-manifests/analyst-box/source/diff") {
      if (url.searchParams.get("from") !== "2" || url.searchParams.get("to") !== "3")
        return send(404, { code: "not_found", message: "Version 1 of agent manifest analyst-box was saved as JSON: it has no source." });
      const [before, after] = [sourceEntries(2), sourceEntries(3)];
      return send(200, {
        name: "analyst-box",
        from: 2,
        to: 3,
        added: [after[3]],
        removed: [before[3]],
        changed: [{ path: "AGENT.md", from: { size: before[0]!.size, sha256: before[0]!.sha256 }, to: { size: after[0]!.size, sha256: after[0]!.sha256 } }],
        unchanged: 2,
      });
    }
    // Upload folder: the Runtime holds no file yet; a folder saves as `uploaded` v1.
    if (/^\/v1\/files\/sha256:[0-9a-f]{64}$/.test(path) && req.method === "HEAD")
      return (res.writeHead(404), res.end());
    if (/^\/v1\/files\/sha256:[0-9a-f]{64}$/.test(path) && req.method === "PUT")
      return send(201, { file: path.slice("/v1/files/".length), size: Buffer.byteLength(raw), contentType: "application/octet-stream" });
    if (path === "/v1/agent-manifests/uploaded" && req.method === "PUT") {
      assert.equal(req.headers["content-type"], "application/vnd.nylorun.folder+json");
      const manifest = { manifestSchemaVersion: 8, name: "uploaded", description: "Uploaded from Studio.", harness: { instructions: ["Work."] } };
      if (url.searchParams.get("dryRun") === "true")
        return send(200, {
          name: "uploaded",
          from: null,
          to: 1,
          unchanged: false,
          changes: [
            { section: "manifest", path: "description", op: "add", to: "Uploaded from Studio." },
            { section: "harness", path: "", op: "add", to: manifest.harness },
          ],
          warnings: [],
          errors: [],
          behind: 0,
          moves: { now: 0, nextStart: 0, secrets: 0 },
          manifest,
          diagnostics: [{ severity: "note", code: "file_not_compiled", message: "Kept with the source; not part of the agent", file: "README.md" }],
          compiler: "agent-folder/1",
        });
      return send(200, {
        manifest: { name: "uploaded", version: 1, hash: "u1", manifest, savedBy: { actor: "studio" }, createdAt: time, agents: 0, source: { compiler: "agent-folder/1", files: 2, bytes: 60 } },
        unchanged: false,
        warnings: [],
      });
    }
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
    if (path === "/v1/agents/team%2Fbuild/triggers")
      return send(200, { triggers: [trigger(triggerStatus)] });
    if (/^\/v1\/agents\/team%2Fbuild\/triggers\/weekly-kpi\/(?:pause|resume)$/.test(path) && req.method === "POST") {
      triggerStatus = path.endsWith("/pause") ? "paused" : "active";
      return send(200, { triggers: [trigger(triggerStatus)] });
    }
    if (path === "/v1/agents/team%2Fbuild/triggers/weekly-kpi/run" && req.method === "POST")
      return send(200, { run: { ...run, id: "run-now", firedAt: "2026-10-11T00:00:00.000Z" } });
    if (path === "/v1/agents/team%2Fbuild/runs") return send(200, { runs: [run], nextCursor: null });
    if (path === "/v1/agents/team%2Fbuild/memories")
      return send(200, { memories: memories.map(({ content: _, ...rest }) => rest), nextCursor: null });
    if (/^\/v1\/agents\/team%2Fbuild\/memories\/[^/]+$/.test(path)) {
      const found = memories.find((m) => m.path === decodeURIComponent(path.split("/")[5]!));
      if (!found) return send(404, { code: "memory_not_found", message: "Memory not found" });
      if (req.method === "DELETE") {
        memories = memories.filter((m) => m !== found);
        return send(200, { path: found.path, deleted: 1 });
      }
      return send(200, found);
    }
    if (path === "/v1/agents/team%2Fbuild/memory_versions")
      return send(200, { versions: [memoryVersion], nextCursor: null });
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
    if (path === "/v1/tenant/limits" && req.method === "PUT") {
      limitOverrides = JSON.parse(raw).limits ?? {};
      return send(200, { limits: { ...RUNTIME_LIMIT_DEFAULTS, ...limitOverrides } });
    }
    if (path === "/v1/tenant/limits") return send(200, { limits: { ...RUNTIME_LIMIT_DEFAULTS, ...limitOverrides } });
    if (path === "/v1/tenant/sandbox") {
      if (req.method === "PUT") {
        const body = JSON.parse(raw);
        const mib = (size: string) => Number.parseInt(size, 10) * (size.endsWith("GiB") ? 1024 : 1);
        sandboxConfig = {
          limits: {
            ...body.limits,
            resources: { cpus: body.limits.resources.cpus, memoryMiB: mib(body.limits.resources.memory) },
            defaultResources: {
              cpus: body.limits.defaultResources.cpus,
              memoryMiB: mib(body.limits.defaultResources.memory),
            },
          },
          lifecycle: body.lifecycle,
        };
      }
      return send(200, {
        preference: "auto",
        backend: "virtual",
        isolation: "process",
        reason: "No container runtime: Agents run in the harness's workspace",
        probes: [
          { name: "virtual", available: true, isolation: "process" },
          { name: "local", available: false, isolation: "process", reason: "Not enabled" },
        ],
        defaultImage: "ghcr.io/nylorun/sandbox:0.29",
        config: sandboxConfig,
        cluster: null,
      });
    }
    if (path === "/v1/tenant/artifacts")
      return send(200, { limits: { fileBytes: 100 * MiB, totalBytes: 10 * 1024 * MiB }, usedBytes: 12 * MiB });
    if (path === "/v1/tenant/skills") return send(200, { limits: { totalBytes: 2 * 1024 * MiB } });
    if (path === "/v1/tenant/usage") {
      const period = url.searchParams.get("period") ?? "total";
      const calls = period === "day" ? 4 : period === "month" ? 120 : 300;
      return send(200, {
        scope: url.searchParams.get("scope") ?? "tenant",
        period,
        ...(period === "total" ? {} : { since: period === "day" ? "2026-10-18T00:00:00.000Z" : "2026-10-01T00:00:00.000Z" }),
        calls,
        tokens: calls * 10_000,
        costUsd: calls * 0.5,
      });
    }
    if (path === "/v1/tenant/budgets") {
      if (req.method === "PUT") budgets = JSON.parse(raw).budgets;
      return send(200, { budgets });
    }
    if (path === "/v1/tenant/tool-policy") {
      if (req.method === "PUT") toolRules = JSON.parse(raw).rules;
      return send(200, { rules: toolRules });
    }
    if (path === "/v1/tenant/keys") return send(200, { keys: [{ id: "web-app", role: "application", createdAt: time }] });
    if (path === "/v1/tenant/signing-keys")
      return send(200, {
        keys: [
          {
            id: "sk_current",
            state: "current",
            alg: "ES256",
            publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "sk_current", alg: "ES256", use: "sig" },
            createdAt: time,
            activatedAt: time,
            retiredAt: null,
            revokedAt: null,
          },
        ],
      });
    if (path === "/v1/tenant/reset" && req.method === "POST") return send(200, { ok: true });
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
