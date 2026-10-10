import { afterEach, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { Agent } from "@nylorun/core/define";
import {
  ArtifactPageSchema,
  ListArtifactsResponseSchema,
} from "@nylorun/core/contracts";
import { createClient } from "@nylorun/agents";
import { startTestTenant } from "../support/tenant.js";
import { testTenantPool } from "../support/store.js";
import { testIssuer } from "../support/issuer.js";
import { readCursor } from "../../src/reads/cursor.js";
import { createTrustedIssuers } from "../../src/tenant/issuers.js";
import { MemoryStreams } from "../../src/streams/memory.js";

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function boot(options: Parameters<typeof startTestTenant>[0] = {}) {
  const rt = await startTestTenant(options);
  closers.push(() => rt.close());
  const client = createClient({ url: rt.url, key: rt.applicationKey });
  for (const agentId of ["bot", "other"]) {
    const built = Agent({ id: agentId, name: agentId })
      .instructions("Answer.")
      .build();
    await client.saveAgent(built);
  }
  for (const [id, agentId, ownerUserId] of [
    ["ann-a", "bot", "ann"],
    ["ann-b", "other", "ann"],
    ["bob-a", "bot", "bob"],
  ])
    await client.createSession({ id, agentId, ownerUserId });
  const ids: string[] = [];
  for (const [name, sessionId, labels] of [
    ["tenant.txt", undefined, undefined],
    ["first.txt", "ann-a", { team: "one", status: "a=b" }],
    ["second.txt", "ann-a", { team: "one", status: "a=b" }],
    ["third.txt", "ann-a", { team: "two" }],
    ["other.txt", "ann-b", { team: "one", status: "a=b" }],
    ["bob.txt", "bob-a", { team: "one", status: "a=b" }],
  ] as const) {
    const { artifact } = await client.artifacts.upload(name, {
      name,
      sessionId,
      labels,
    });
    ids.push(artifact.artifactId);
  }
  // Tie fixture: public uploads, with deterministic metadata timestamps for paging.
  await testTenantPool(
    rt.tenantId,
  )`update nylorun.artifacts set created_at = '2026-01-01T00:00:00.000123Z'`;
  return { rt, client, ids };
}
async function get(rt: Runtime, query: string, headers = rt.headers()) {
  return fetch(`${rt.url}/v1/artifacts${query ? `?${query}` : ""}`, {
    headers,
  });
}
async function page(
  rt: Runtime,
  query: string,
  headers?: Record<string, string>,
) {
  const response = await get(rt, query, headers);
  expect(response.status, await response.clone().text()).toBe(200);
  return ArtifactPageSchema.parse(await response.json());
}

it("preserves strict legacy responses, pages timestamp ties and returns metadata without history or bytes", async () => {
  const { rt, client, ids } = await boot();
  await client.artifacts.uploadVersion(ids[2]!, "new version");
  const legacy = ListArtifactsResponseSchema.parse(
    await (await get(rt, "")).json(),
  );
  expect(legacy.artifacts.map((a) => a.artifactId)).toEqual([...ids].sort());
  expect(
    await (await get(rt, "cursor=ignored&kind=folder&label=ignored")).json(),
  ).toEqual(legacy);
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const next = await client.artifacts.page({ limit: 2, cursor });
    expect(next.artifacts.length).toBeLessThanOrEqual(2);
    found.push(...next.artifacts.map((a) => a.artifactId));
    expect(JSON.stringify(next)).not.toMatch(
      /versions|blobKey|sha256|contentKey/,
    );
    cursor = next.nextCursor ?? undefined;
  } while (cursor);
  expect(found).toEqual([...ids].sort().reverse());
  const updated = (await client.artifacts.page()).artifacts.find(
    (a) => a.artifactId === ids[2],
  );
  expect(updated?.latestVersion).toBe(2);
  expect(updated?.contentType).toBe("text/plain; charset=utf-8");
  expect((await get(rt, "sessionId=missing")).status).toBe(404);
  expect((await get(rt, "limit=1&sessionId=missing")).status).toBe(404);
  expect((await fetch(`${rt.url}/health`)).status).toBe(200);
  const health = await (await fetch(`${rt.url}/health`)).json();
  expect(health.protocol.features).toContain("artifact-reads");
});

it("filters session, kind and every normalized label, excluding Tenant-owned artifacts with sessionId", async () => {
  const { rt, client, ids } = await boot();
  const filters = {
    sessionId: "ann-a",
    kind: "file" as const,
    labels: { team: "one", status: "a=b" },
  };
  const first = await client.artifacts.page({ ...filters, limit: 1 });
  expect(first.artifacts.map((a) => a.artifactId)).toEqual([ids[2]]);
  const second = await page(
    rt,
    `limit=1&sessionId=ann-a&kind=file&label=status=a%3Db&label=team=one&cursor=${first.nextCursor}`,
  );
  expect(second.artifacts.map((a) => a.artifactId)).toEqual([ids[1]]);
  expect(second.nextCursor).toBeNull();
  expect((await client.artifacts.page({ kind: "folder" })).artifacts).toEqual(
    [],
  );
  expect(
    (await client.artifacts.page({ sessionId: "ann-a" })).artifacts.map(
      (a) => a.artifactId,
    ),
  ).toEqual([ids[3], ids[2], ids[1]]);
  for (const query of [
    `limit=1&cursor=${first.nextCursor}`,
    `limit=1&sessionId=ann-b&kind=file&label=team=one&label=status=a%3Db&cursor=${first.nextCursor}`,
    `limit=1&sessionId=ann-a&kind=folder&label=team=one&label=status=a%3Db&cursor=${first.nextCursor}`,
    `limit=1&sessionId=ann-a&kind=file&label=team=two&label=status=a%3Db&cursor=${first.nextCursor}`,
  ]) {
    const response = await get(rt, query);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("cursor_mismatch");
  }
});

it("reapplies subject ownership, agent grants and scopes before limiting every page", async () => {
  const issuer = await testIssuer({ agents: ["bot"] });
  const blocked = await testIssuer({
    name: "blocked",
    iss: "https://blocked-issuer.test",
    agents: [],
  });
  const { rt, client, ids } = await boot({
    issuers: createTrustedIssuers([...issuer.configs, ...blocked.configs]),
  });
  const ann = client.as("ann", { scopes: ["sessions:own"] });
  expect(
    (await ann.artifacts.page()).artifacts.map((a) => a.artifactId),
  ).toEqual(ids.slice(1, 5).reverse());
  const token = await issuer.sign("ann", ["sessions:own"]);
  const headers = { authorization: `Bearer ${token}` };
  const first = await page(rt, "limit=1", headers);
  expect(first.artifacts.map((a) => a.artifactId)).toEqual([ids[3]]);
  const denied = await blocked.sign("ann", ["sessions:own"]);
  expect(
    await page(rt, `limit=1&cursor=${first.nextCursor}`, {
      authorization: `Bearer ${denied}`,
    }),
  ).toEqual({ artifacts: [], nextCursor: null });
  // Move the remaining session to another owner after page one: the cursor grants nothing.
  await testTenantPool(
    rt.tenantId,
  )`update nylorun.sessions set body = jsonb_set(body::jsonb, '{ownerUserId}', '"bob"'::jsonb)::json where id = 'ann-a'`;
  const second = await page(rt, `limit=1&cursor=${first.nextCursor}`, headers);
  expect(second).toEqual({ artifacts: [], nextCursor: null });
  expect((await get(rt, "limit=1&sessionId=ann-b", headers)).status).toBe(404);
  const noScope = await issuer.sign("ann", []);
  expect(
    (
      await get(rt, `limit=1&cursor=${first.nextCursor}`, {
        authorization: `Bearer ${noScope}`,
      })
    ).status,
  ).toBe(403);
  expect((await get(rt, "limit=1", rt.managementHeaders())).status).toBe(403);
  const bob = await client
    .as("bob", { scopes: ["sessions:own"] })
    .artifacts.page({ limit: 1 });
  expect(bob.artifacts.map((a) => a.artifactId)).toEqual([ids[5]]);
});

it("resumes across concurrent insertion, deletion and Runtime restart without repeating earlier rows", async () => {
  const streams = new MemoryStreams();
  const { rt, client, ids } = await boot({ retainRoot: true, streams });
  const first = await client.artifacts.page({ limit: 2 });
  const added = await client.artifacts.upload("new", { name: "new.txt" });
  await client.artifacts.delete(ids[3]!);
  const next = await client.artifacts.page({
    limit: 2,
    cursor: first.nextCursor!,
  });
  expect(next.artifacts.map((a) => a.artifactId)).toEqual([ids[2], ids[1]]);
  await closers.pop()!();
  const restarted = await startTestTenant({
    tenantId: rt.tenantId,
    applicationKey: rt.applicationKey,
    hostRoot: rt.root,
    streams,
  });
  closers.push(async () => {
    await restarted.close();
    await streams.close();
    await rm(rt.root, { recursive: true, force: true });
  });
  const last = await page(restarted, `limit=2&cursor=${next.nextCursor}`);
  expect(last.artifacts.map((a) => a.artifactId)).toEqual([ids[0]]);
  expect(last.nextCursor).toBeNull();
  const fresh = await page(restarted, "limit=1");
  expect(fresh.artifacts[0]?.artifactId).toBe(added.artifact.artifactId);
});

it("matches arbitrary label strings exactly, including escaped JSON, Unicode and empty values", async () => {
  const { client } = await boot();
  const labels = {
    'key"\\': 'a"\\,}:[]',
    unicode: "设计",
    empty: "",
    nul: "\u0000",
    surrogate: "\ud800",
  };
  const { artifact } = await client.artifacts.upload("labels", {
    name: "labels.txt",
    labels,
  });
  const decoy = await client.artifacts.upload("decoy", {
    name: "decoy.txt",
    labels: {
      ...labels,
      nul: "literal",
      surrogate: "literal",
      unicode: "other",
      embedded: JSON.stringify(labels),
    },
  });
  expect(
    (await client.artifacts.page({ labels })).artifacts.map(
      (a) => a.artifactId,
    ),
  ).toEqual([artifact.artifactId]);
  for (const [key, value] of Object.entries(labels)) {
    const found = (
      await client.artifacts.page({ labels: { [key]: value } })
    ).artifacts.map((a) => a.artifactId);
    expect(found).toContain(artifact.artifactId);
    if (["nul", "surrogate", "unicode"].includes(key))
      expect(found).not.toContain(decoy.artifact.artifactId);
  }
});

it("drains a multi-page fixture using the public API and records representative index plans", async () => {
  const { rt, client, ids } = await boot();
  const count = process.env.ARTIFACT_READS_EVIDENCE ? 10_000 : 1_000;
  const sql = testTenantPool(rt.tenantId);
  // Metadata fixtures model both kinds; no blob reads are needed for a list.
  await sql`insert into nylorun.artifacts (id,kind,name,content_type,session_id,latest_version,labels_json,created_at,updated_at)
    select 'af_' || lpad(n::text,26,'0'), case when n % 2 = 0 then 'file' else 'folder' end,
      'fixture-' || n, 'text/plain', 'ann-a', 1, '{"team":"one"}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
    from generate_series(1,${count}) n`;
  await sql`analyze nylorun.artifacts`;
  const found: string[] = [];
  let cursor: string | undefined;
  let deepId = "";
  const start = performance.now();
  do {
    const next = await client.artifacts.page({ cursor });
    expect(next.artifacts.length).toBeLessThanOrEqual(50);
    found.push(...next.artifacts.map((a) => a.artifactId));
    if (found.length === count / 2) deepId = next.artifacts.at(-1)!.artifactId;
    cursor = next.nextCursor ?? undefined;
  } while (cursor);
  const drainMs = performance.now() - start;
  expect(found).toHaveLength(count + ids.length);
  expect(new Set(found).size).toBe(found.length);
  expect(found.slice(0, count)).toEqual(
    Array.from(
      { length: count },
      (_, i) => `af_${String(count - i).padStart(26, "0")}`,
    ),
  );
  const folders = await client.artifacts.page({
    kind: "folder",
    sessionId: "ann-a",
    labels: { team: "one" },
  });
  expect(folders.artifacts).toHaveLength(50);
  expect(
    folders.artifacts.every(
      (a) => a.kind === "folder" && a.sessionId === "ann-a",
    ),
  ).toBe(true);
  if (process.env.ARTIFACT_READS_EVIDENCE) {
    const first =
      await sql`explain (analyze,buffers,format json) select * from nylorun.artifacts order by created_at desc,id desc limit 51`;
    const deep =
      await sql`explain (analyze,buffers,format json) select * from nylorun.artifacts where (created_at,id) < ('2026-01-02T00:00:00.000Z',${deepId}) order by created_at desc,id desc limit 51`;
    const session =
      await sql`explain (analyze,buffers,format json) select * from nylorun.artifacts where session_id='ann-a' and (created_at,id) < ('2026-01-02T00:00:00.000Z',${deepId}) order by created_at desc,id desc limit 51`;
    await writeFile(
      process.env.ARTIFACT_READS_EVIDENCE,
      JSON.stringify(
        {
          server: (await sql`select version()`)[0]!.version,
          rows: found.length,
          drainMs,
          first: first[0]!["QUERY PLAN"],
          deep: deep[0]!["QUERY PLAN"],
          session: session[0]!["QUERY PLAN"],
        },
        null,
        2,
      ) + "\n",
    );
  }
}, 30_000);

it("rejects invalid queries and typed, cross-route and cross-Tenant cursors through ordinary public errors", async () => {
  const { rt, client } = await boot();
  for (const query of [
    "limit=0",
    "limit=201",
    "limit=-1",
    "limit=1.5",
    "limit=",
    "limit=NaN",
    "limit=1&kind=invalid",
    "limit=1&label=broken",
    "limit=1&unknown=x",
    "limit=1&cursor=broken",
    "limit=1&cursor=%25",
  ]) {
    expect((await get(rt, query)).status, query).toBe(400);
  }
  expect((await page(rt, "limit=200")).nextCursor).toBeNull();
  const binding = { sessionId: null, kind: null, labels: [] };
  for (const key of [
    [null, "id"],
    ["bad-date", "id"],
    ["2026-01-01T00:00:00.000Z", ""],
    ["2026-01-01T00:00:00.000Z", "not-an-artifact-id"],
    ["2026-01-01T00:00:00.000Z", "af_0000000000000000000000000\u0000"],
    ["id"],
  ]) {
    const cursor = readCursor(rt.tenantId, "artifacts", binding).encode(key);
    const response = await get(rt, `limit=1&cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("cursor_invalid");
  }
  const sessions = await client.sessions.page({ limit: 1 });
  expect((await get(rt, `limit=1&cursor=${sessions.nextCursor}`)).status).toBe(
    400,
  );
  const artifacts = await client.artifacts.page({ limit: 1 });
  const another = await startTestTenant();
  closers.push(() => another.close());
  const mismatch = await get(another, `limit=1&cursor=${artifacts.nextCursor}`);
  expect(mismatch.status).toBe(400);
  expect((await mismatch.json()).code).toBe("cursor_mismatch");
});
