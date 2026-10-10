/**
 * Access acceptance (Phase 1) on a local Tenant, under a temporary
 * NYLORUN_HOME and a unique Tenant name (never ~/.nylorun):
 *
 *   node scripts/acceptance/access.mjs
 *
 * Images: see scripts/lib/stack.mjs (built from this checkout, or named by
 * NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE). Needs the workspace builds of
 * @nylorun/core, @nylorun/agents, @nylorun/admin and nylorun.
 *
 * A1  three subjects (admin, builder, member) on one Tenant, each acting
 *     through `app.as(...)`: a session with the person's vault (created with the
 *     management key: vaults are the Management API, protocol 8) and a turn
 *     that pauses for approval of an HTTP tool, which the Runtime then calls on a
 *     service of this script, and completes
 * A2  concurrent event streams: each subject receives only its own events
 * A3  every Tenant route, called by each subject against the others'
 *     resources, answers the 404 or 403 of the scope and owner tables (the
 *     Management API, `/v1/tenant/*` with its vaults: `403 key_role_mismatch`
 *     for every subject), and no body names another subject's ids; the
 *     management key acts for no subject and reaches no Runtime API route
 * A4  a stub app server strips the Nylorun-* headers its client sends; the
 *     Runtime sees the signed-in person
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { createManagementClient } from "@nylorun/admin";
import { Agent, createClient } from "@nylorun/agents";
import { startToolService } from "../lib/tool-service.mjs";
import { ensureImages, eventually, runtimeHeaders, withStack } from "../lib/stack.mjs";
import { withResetTenant } from "../lib/stack-tenant.mjs";

// No subject scope reaches the Management API (`tenant:settings` is retired, protocol 8).
const SUBJECTS = {
  admin: ["agents:write", "sessions:own", "sandboxes:write"],
  builder: ["agents:write", "sessions:own"],
  member: ["agents:read", "sessions:own"],
};

const results = [];
function pass(id, message) {
  results.push({ id, message });
  console.log(`PASS ${id}: ${message}`);
}

/**
 * The fixture model calls `lookup_order` on a turn's first step, then answers. The tool is an
 * HTTP tool of `service`, which waits for approval on every call.
 */
function deskAgent(service) {
  return Agent({ id: "desk", name: "Desk" })
    .tools(
      service.tool("lookup_order", {
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        approval: "always",
      }),
    )
    .build();
}

async function session(runtime, tenant, id, as) {
  const response = await fetch(`${runtime}/v1/sessions/${id}`, {
    headers: runtimeHeaders(tenant.env.NYLORUN_SERVER_KEY, subjectHeaders(as)),
    signal: AbortSignal.timeout(10_000),
  });
  return response.json();
}

function subjectHeaders(as) {
  return as ? { "Nylorun-Subject": as.name, "Nylorun-Scopes": as.scopes.join(" ") } : {};
}

/** A1: each subject's own vault (the operator's to create), session and approved turn. */
async function a1(runtime, tenant, app) {
  const management = createManagementClient({ url: runtime, key: tenant.managementKey });
  const people = {};
  for (const [role, scopes] of Object.entries(SUBJECTS)) {
    const name = `app:${role}`;
    const client = app.as(name, { scopes });
    const vault = await management.vaults.create({
      name: `${role}'s vault`,
      ownerUserId: name,
      idempotencyKey: `vault-${role}`,
    });
    const credential = await management.vaults.credentials.create(vault.id, {
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
  const v = `/v1/tenant/vaults/${other.vaultId}`;
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
    // Vault routes are the Management API (protocol 8): an application key, acting for a
    // subject or not, is refused before anything is read.
    ["GET", v, 403],
    ["DELETE", v, 403],
    ["GET", `${v}/credentials`, 403],
    [
      "POST",
      `${v}/credentials`,
      403,
      {
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        name: "t",
        auth: { type: "bearer", url: "https://mcp.example.com/tools", token: "x" },
      },
    ],
    ["GET", c, 403],
    ["DELETE", c, 403],
  ];
}

/**
 * Routes whose answer depends only on the caller's scopes. No subject reaches the Management
 * API (`/v1/tenant/*`): `403 key_role_mismatch`, whatever its scopes.
 */
const SCOPED = [
  ["GET", "/v1/agents", { admin: 200, builder: 200, member: 200 }],
  ["GET", "/v1/tenant", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/tenant/models", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/tenant/providers", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/tenant/model", { admin: 403, builder: 403, member: 403 }],
  ["POST", "/v1/tenant/reset", { admin: 403, builder: 403, member: 403 }],
  ["PUT", "/v1/tenant/config/seed", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/tenant/keys", { admin: 403, builder: 403, member: 403 }],
  ["GET", "/v1/tenant/signing-keys", { admin: 403, builder: 403, member: 403 }],
];

async function a3(runtime, tenant, people) {
  const management = createManagementClient({ url: runtime, key: tenant.managementKey });
  const call = async (as, method, path, body, key = tenant.env.NYLORUN_SERVER_KEY) => {
    const response = await fetch(`${runtime}${path}`, {
      method,
      headers: runtimeHeaders(key, {
        ...subjectHeaders(as),
        ...(body ? { "content-type": "application/json" } : {}),
      }),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, text: await response.text() };
  };
  /** The Management API refuses an application key, for a subject or not, by its role. */
  const roleRefused = (reply, what) => {
    if (reply.status === 403 && what.includes(" /v1/tenant"))
      assert.equal(JSON.parse(reply.text).code, "key_role_mismatch", `${what}: ${reply.text}`);
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
        roleRefused(reply, `${caller.role} ${method} ${path}`);
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
    const vaults = await call(caller, "GET", "/v1/tenant/vaults");
    assert.equal(vaults.status, 403, `${caller.role} lists no vaults`);
    roleRefused(vaults, `${caller.role} GET /v1/tenant/vaults`);
    for (const other of others)
      assert.equal(
        (await call(caller, "GET", `/v1/tenant/vaults?ownerUserId=${encodeURIComponent(other.name)}`)).status,
        403,
      );
    // A retired scope still parses and grants nothing: `tenant:settings` reaches no setting.
    const retired = await call(
      { name: caller.name, scopes: [...caller.scopes, "tenant:settings"] },
      "GET",
      "/v1/tenant/model",
    );
    assert.equal(retired.status, 403, `${caller.role} with tenant:settings: ${retired.text}`);
    roleRefused(retired, `${caller.role} GET /v1/tenant/model`);
    for (const [method, path, expected] of SCOPED) {
      const reply = await call(caller, method, path);
      assert.equal(reply.status, expected[caller.role], `${caller.role} ${method} ${path}: ${reply.text}`);
      clean(reply, `${method} ${path}`);
      roleRefused(reply, `${caller.role} ${method} ${path}`);
      checked += 1;
    }
  }
  // The application key alone reaches no Management API route either.
  const unscoped = await call(undefined, "GET", "/v1/tenant/vaults");
  assert.equal(unscoped.status, 403, unscoped.text);
  roleRefused(unscoped, "the application key GET /v1/tenant/vaults");
  // The management key acts as itself only, and only on the Management API.
  const managementKey = tenant.managementKey;
  const forSubject = await call(people.admin, "GET", "/v1/tenant/vaults", undefined, managementKey);
  assert.equal(forSubject.status, 403, `a management key acting for a subject: ${forSubject.text}`);
  assert.equal(JSON.parse(forSubject.text).code, "subject_invalid");
  const onRuntime = await call(undefined, "GET", "/v1/sessions", undefined, managementKey);
  assert.equal(onRuntime.status, 403, `a management key on the Runtime API: ${onRuntime.text}`);
  assert.equal(JSON.parse(onRuntime.text).code, "key_role_mismatch");
  checked += 3;
  // Every session is still there for its owner, and every vault for the operator.
  for (const person of everyone) {
    assert.equal((await call(person, "GET", `/v1/sessions/${person.sessionId}`)).status, 200);
    assert.equal((await management.vaults.get(person.vaultId)).id, person.vaultId);
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
      headers: runtimeHeaders(tenant.env.NYLORUN_SERVER_KEY, {
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
}

try {
  const images = await ensureImages();
  await withStack({ name: "nylorun-access", images, startArgs: ["--no-studio"] }, async (stack) => {
    const runtime = stack.runtimeUrl;
    await withResetTenant({ stack, name: "access" }, async (tenant) => {
      const app = createClient({
        url: tenant.env.NYLORUN_RUNTIME_URL,
        key: tenant.env.NYLORUN_SERVER_KEY,
      });
      assert.ok(
        (await app.hostFeatures()).includes("subject-headers"),
        "the Runtime advertises subject-headers",
      );
      const service = await startToolService({ lookup_order: () => ({ status: "shipped" }) });
      try {
        await app.saveAgent(deskAgent(service));
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
        assert.equal(
          service.calls.filter((call) => call.name === "lookup_order").length,
          Object.keys(people).length,
          "the Runtime called the approved HTTP tool once per turn",
        );
        pass("A1", "admin, builder and member each ran a turn with an approved HTTP tool call in their own session");
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
        await service.close();
      }
    });
  });
  console.log("\nAccess acceptance on a local Tenant:");
  for (const item of results) console.log(`  PASS ${item.id} ${item.message}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
