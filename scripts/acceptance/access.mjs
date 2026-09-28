/**
 * Access acceptance (Phase 1) on the local Docker stack, under a temporary
 * NYLORUN_HOME and a unique stack project (never ~/.nylorun):
 *
 *   node scripts/acceptance/access.mjs
 *
 * Images: see scripts/lib/stack.mjs (built from this checkout, or named by
 * NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE). Needs the workspace builds of
 * @nylorun/core, @nylorun/agents, @nylorun/admin, nylorun and @nylorun/cli.
 *
 * A1  three subjects (admin, builder, member) on one Tenant, each acting
 *     through `app.as(...)`: a vault, a session and a turn that pauses for
 *     approval and completes
 * A2  concurrent event streams: each subject receives only its own events
 * A3  every Tenant route, called by each subject against the others'
 *     resources, answers the 404 or 403 of the scope and owner tables, and no
 *     body names another subject's ids
 * A4  a stub app server strips the Nylorun-* headers its client sends; the
 *     Runtime sees the signed-in person. An executor key naming a subject is 403
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import {
  Agent,
  connectAgents,
  createClient,
  deriveExecutorToken,
  tool,
} from "@nylorun/agents";
import { ensureImages, eventually, tenantHeaders, withStack } from "../lib/stack.mjs";
import { withTemporaryTenant } from "../lib/temporary-tenant.mjs";

const SUBJECTS = {
  admin: ["tenant:settings", "agents:write", "sessions:own", "vaults:own"],
  builder: ["agents:write", "sessions:own", "vaults:own"],
  member: ["agents:read", "sessions:own", "vaults:own"],
};

const results = [];
function pass(id, message) {
  results.push({ id, message });
  console.log(`PASS ${id}: ${message}`);
}

// The fixture model calls `lookup_order` on a turn's first step, then answers.
const desk = Agent({ id: "desk", name: "Desk" })
  .use({
    id: "orders",
    tools: [
      tool({
        name: "lookup_order",
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        approval: () => "Look up this order?",
        async run() {
          return { status: "shipped" };
        },
      }),
    ],
  })
  .build();

async function session(runtime, tenant, id, as) {
  const response = await fetch(`${runtime}/v1/sessions/${id}`, {
    headers: tenantHeaders(tenant.id, tenant.env.NYLORUN_SERVER_KEY, subjectHeaders(as)),
    signal: AbortSignal.timeout(10_000),
  });
  return response.json();
}

function subjectHeaders(as) {
  return as ? { "Nylorun-Subject": as.name, "Nylorun-Scopes": as.scopes.join(" ") } : {};
}

/** A1: each subject's own vault, session and approved turn. */
async function a1(runtime, tenant, app) {
  const people = {};
  for (const [role, scopes] of Object.entries(SUBJECTS)) {
    const name = `app:${role}`;
    const client = app.as(name, { scopes });
    const vault = await client.createVault({
      name: `${role}'s vault`,
      ownerUserId: name,
      idempotencyKey: `vault-${role}`,
    });
    const credential = await client.createCredential(vault.id, {
      name: "token",
      idempotencyKey: `cred-${role}`,
      auth: { type: "bearer", url: "https://mcp.example.com/tools", token: `secret-${role}` },
    });
    const id = `sess-${role}-${randomUUID().slice(0, 8)}`;
    await client.createSession({
      id,
      agentId: "desk",
      ownerUserId: name,
      vaultIds: [vault.id],
    });
    people[role] = {
      role,
      name,
      scopes,
      client,
      sessionId: id,
      vaultId: vault.id,
      credentialId: credential.id,
    };
  }
  return people;
}

async function runTurns(runtime, tenant, people) {
  for (const person of Object.values(people)) {
    const s = person.client.session(person.sessionId);
    await s.input(`Where is ${person.role}'s order?`, { idempotencyKey: `msg-${person.role}` });
    await eventually(
      async () => (await session(runtime, tenant, person.sessionId, person)).status === "paused",
      { message: `${person.role}'s turn to pause for approval` },
    );
    const pending = await s.pending();
    const interaction = pending.find((wait) => wait?.interaction?.kind === "approval")?.interaction;
    assert.ok(interaction, `${person.role} has a pending approval: ${JSON.stringify(pending)}`);
    await s.approve(interaction.id, true, { idempotencyKey: `approve-${person.role}` });
    await eventually(
      async () =>
        (await session(runtime, tenant, person.sessionId, person)).status === "completed",
      { message: `${person.role}'s turn to complete` },
    );
  }
}

/** Every route a subject might call on `other`'s resources, and what it must answer. */
function crossRoutes(other) {
  const s = `/v1/sessions/${other.sessionId}`;
  const v = `/v1/vaults/${other.vaultId}`;
  const c = `${v}/credentials/${other.credentialId}`;
  const command = (body) => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), ...body });
  return [
    ["GET", s, 404],
    ["GET", `${s}/items`, 404],
    ["GET", `${s}/events`, 404],
    ["POST", `${s}/commands`, 404, command({ type: "message", content: "take over" })],
    ["POST", `${s}/commands`, 404, command({ type: "approve", interactionId: "i", approved: true })],
    ["POST", `${s}/commands`, 404, command({ type: "respond", interactionId: "i", value: 1 })],
    ["POST", `${s}/commands`, 404, command({ type: "cancel" })],
    ["GET", v, 404],
    ["DELETE", v, 404],
    ["GET", `${v}/credentials`, 404],
    [
      "POST",
      `${v}/credentials`,
      404,
      {
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        name: "t",
        auth: { type: "bearer", url: "https://mcp.example.com/tools", token: "x" },
      },
    ],
    ["GET", c, 404],
    ["DELETE", c, 404],
  ];
}

/** Routes whose answer depends only on the caller's scopes. */
const SCOPED = [
  ["GET", "/v1/agents", { admin: 200, builder: 200, member: 200 }],
  ["GET", "/v1/tenant", { admin: 200, builder: 403, member: 403 }],
  ["GET", "/v1/tenant/models", { admin: 200, builder: 200, member: 403 }],
  ["GET", "/v1/tenant/providers", { admin: 200, builder: 200, member: 403 }],
  ["GET", "/v1/tenant/model", { admin: 200, builder: 403, member: 403 }],
  ["POST", "/v1/tenant/reset", { admin: 403, builder: 403, member: 403 }],
  ["PUT", "/v1/tenant/config/seed", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/executors", { admin: 403, builder: 403, member: 403 }],
  ["PUT", "/v1/executors", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/actions", { admin: 403, builder: 403, member: 403 }],
];

async function a3(runtime, tenant, people) {
  const key = tenant.env.NYLORUN_SERVER_KEY;
  const call = async (as, method, path, body) => {
    const response = await fetch(`${runtime}${path}`, {
      method,
      headers: tenantHeaders(tenant.id, key, {
        ...subjectHeaders(as),
        ...(body ? { "content-type": "application/json" } : {}),
      }),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, text: await response.text() };
  };
  const everyone = Object.values(people);
  let checked = 0;
  for (const caller of everyone) {
    const others = everyone.filter((p) => p !== caller);
    const foreign = others.flatMap((p) => [p.sessionId, p.vaultId, p.credentialId]);
    const clean = (reply, what) => {
      for (const id of foreign)
        assert.ok(!reply.text.includes(id), `${caller.role}: ${what} names another subject's ${id}`);
    };
    for (const other of others)
      for (const [method, path, expected, body] of crossRoutes(other)) {
        const reply = await call(caller, method, path, body);
        assert.equal(reply.status, expected, `${caller.role} ${method} ${path}: ${reply.text}`);
        clean(reply, `${method} ${path}`);
        checked += 1;
      }
    // PUT on another subject's session id: 404, not 409.
    for (const other of others) {
      const reply = await call(caller, "PUT", `/v1/sessions/${other.sessionId}`, {
        requestId: randomUUID(),
        agentId: "desk",
        ownerUserId: caller.name,
      });
      assert.equal(reply.status, 404, `${caller.role} PUT ${other.role}'s session`);
      checked += 1;
    }
    // Lists hold only the caller's own resources; another owner's list is refused.
    const sessions = await call(caller, "GET", "/v1/sessions");
    assert.deepEqual(
      JSON.parse(sessions.text).sessions.map((s) => s.id),
      [caller.sessionId],
      `${caller.role} lists only its session`,
    );
    const vaults = await call(caller, "GET", "/v1/vaults");
    assert.deepEqual(
      JSON.parse(vaults.text).vaults.map((v) => v.id),
      [caller.vaultId],
      `${caller.role} lists only its vault`,
    );
    for (const other of others)
      assert.equal(
        (await call(caller, "GET", `/v1/vaults?ownerUserId=${encodeURIComponent(other.name)}`)).status,
        403,
      );
    for (const [method, path, expected] of SCOPED) {
      const reply = await call(caller, method, path);
      assert.equal(reply.status, expected[caller.role], `${caller.role} ${method} ${path}: ${reply.text}`);
      clean(reply, `${method} ${path}`);
      checked += 1;
    }
  }
  // Every session and vault is still there for its owner.
  for (const person of everyone) {
    assert.equal((await call(person, "GET", `/v1/sessions/${person.sessionId}`)).status, 200);
    assert.equal((await call(person, "GET", `/v1/vaults/${person.vaultId}`)).status, 200);
  }
  return checked;
}

/** A4: a stub app server that signs people in by `x-user` and never forwards Nylorun-* headers. */
async function a4(runtime, tenant, people) {
  const server = createServer(async (req, res) => {
    const person = people[req.headers["x-user"]];
    if (!person) {
      res.writeHead(401).end();
      return;
    }
    // The client's own headers, minus credentials and any Nylorun-* header.
    const forwarded = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name]) => !name.startsWith("nylorun-") && !["authorization", "host", "connection"].includes(name),
      ),
    );
    const response = await fetch(`${runtime}/v1/sessions`, {
      headers: tenantHeaders(tenant.id, tenant.env.NYLORUN_SERVER_KEY, {
        ...forwarded,
        ...subjectHeaders(person),
      }),
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const forged = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: {
        "x-user": "member",
        "Nylorun-Subject": people.admin.name,
        "Nylorun-Scopes": SUBJECTS.admin.join(" "),
      },
    });
    assert.equal(forged.status, 200);
    assert.deepEqual(
      (await forged.json()).sessions.map((s) => s.id),
      [people.member.sessionId],
      "the Runtime acted for the signed-in member, not the forged admin",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  pass("A4", "an app server that strips client Nylorun-* headers acts only for the signed-in person");

  const executorKey = deriveExecutorToken(tenant.env.NYLORUN_SERVER_KEY, tenant.id, "desk");
  const executor = await fetch(`${runtime}/v1/actions`, {
    headers: tenantHeaders(tenant.id, executorKey, subjectHeaders(people.member)),
  });
  assert.equal(executor.status, 403, await executor.text());
  const plain = await fetch(`${runtime}/v1/actions`, {
    headers: tenantHeaders(tenant.id, executorKey),
  });
  assert.equal(plain.status, 200, "the executor key itself works");
  pass("A4", "an executor key that names a subject is 403");
}

try {
  const images = await ensureImages();
  await withStack({ name: "nylorun-access", images, startArgs: ["--no-studio"] }, async (stack) => {
    const runtime = stack.runtimeUrl;
    const admin = await stack.admin();
    await withTemporaryTenant({ admin, name: "access" }, async (tenant) => {
      const app = createClient({
        url: tenant.env.NYLORUN_RUNTIME_URL,
        key: tenant.env.NYLORUN_SERVER_KEY,
        tenant: tenant.id,
      });
      assert.ok(
        (await app.hostFeatures()).includes("subject-headers"),
        "the Runtime advertises subject-headers",
      );
      const connection = connectAgents({
        agents: [desk],
        application: app,
        implementationVersion: "dev",
      });
      try {
        await connection.ready;
        const people = await a1(runtime, tenant, app);

        // A2: every subject streams its own session while all three turns run.
        const streams = new AbortController();
        const seen = Object.fromEntries(Object.keys(people).map((role) => [role, []]));
        const reading = Object.values(people).map(async (person) => {
          try {
            for await (const event of person.client
              .session(person.sessionId)
              .observe({ signal: streams.signal }))
              seen[person.role].push(event);
          } catch (error) {
            if (!streams.signal.aborted) throw error;
          }
        });
        await runTurns(runtime, tenant, people);
        pass("A1", "admin, builder and member each ran a turn with an approval in their own session");
        await eventually(
          () =>
            Object.values(people).every((person) =>
              seen[person.role].some((event) => event.type === "turn.completed"),
            ),
          { message: "every stream to see its turn complete" },
        );
        streams.abort();
        await Promise.all(reading);
        for (const person of Object.values(people)) {
          const events = seen[person.role];
          assert.ok(events.length > 0, `${person.role} received events`);
          for (const event of events)
            assert.equal(event.sessionId, person.sessionId, `${person.role} saw ${event.sessionId}`);
        }
        pass("A2", "concurrent streams for three subjects each carried only their own events");

        const checked = await a3(runtime, tenant, people);
        pass("A3", `${checked} cross-subject and scope calls answered 404 or 403 and named no one else's ids`);

        await a4(runtime, tenant, people);
      } finally {
        await connection.close();
      }
    });
  });
  console.log("\nAccess acceptance on the stack:");
  for (const item of results) console.log(`  PASS ${item.id} ${item.message}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
