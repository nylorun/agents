import assert from "node:assert/strict";
import test from "node:test";
import { frameAncestorsFrom, startBridge } from "../web/src/embed/bridge.ts";
import {
  EmbedSessionUnavailableError,
  REFRESH_BEFORE_MS,
  createEmbedSession,
} from "../web/src/embed/session.ts";

const APP = "nylorun://localhost";
const OTHER = "http://nylorun.localhost";
const env = (kind, payload = {}, protocol = 1) => ({
  type: "nylorun.studio",
  protocol,
  kind,
  ...payload,
});

function fakeWindow() {
  const posted = [];
  const listeners = new Set();
  const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  return {
    posted,
    parent,
    window: {
      parent,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    deliver(data, origin, source = parent) {
      for (const listener of listeners) listener({ data, origin, source });
    },
  };
}

function bridge(fake, allowed = [APP, OTHER]) {
  const received = [];
  const instance = startBridge({
    window: fake.window,
    allowed,
    studioVersion: "0.13.0-beta",
    onMessage: (message) => received.push(message),
  });
  return { instance, received };
}

test("ready goes once to each allowlisted origin, with that exact target", () => {
  const fake = fakeWindow();
  bridge(fake);
  assert.deepEqual(
    fake.posted.map((entry) => entry.origin),
    [APP, OTHER],
  );
  for (const { message } of fake.posted)
    assert.deepEqual(message, env("ready", { protocols: [1], studioVersion: "0.13.0-beta" }));
  const none = fakeWindow();
  bridge(none, []);
  assert.equal(none.posted.length, 0);
});

test("the first valid init pins the origin; other origins are ignored afterwards", () => {
  const fake = fakeWindow();
  const { instance, received } = bridge(fake);
  fake.posted.length = 0;
  // Nothing before init is accepted, and nothing is posted.
  fake.deliver(env("navigate", { route: "/tenants/t/vault" }), APP);
  instance.post({ kind: "route.changed", route: "/tenants/t" });
  assert.equal(received.length, 0);
  assert.equal(fake.posted.length, 0);

  fake.deliver(env("init", { token: "login-1" }), APP);
  assert.equal(instance.origin(), APP);
  fake.deliver(env("token.refresh", { token: "login-2" }), OTHER);
  fake.deliver(env("token.refresh", { token: "login-3" }), APP);
  assert.deepEqual(
    received.map((message) => message.kind),
    ["init", "token.refresh"],
  );
  assert.equal(received[1].token, "login-3");

  instance.post({ kind: "route.changed", route: "/tenants/t" });
  assert.deepEqual(fake.posted, [{ message: env("route.changed", { route: "/tenants/t" }), origin: APP }]);
});

test("messages from another source, origin or shape are dropped", () => {
  const fake = fakeWindow();
  const { received } = bridge(fake);
  fake.deliver(env("init", { token: "t" }), "https://evil.example");
  fake.deliver(env("init", { token: "t" }), APP, { postMessage() {} });
  fake.deliver({ kind: "init", token: "t" }, APP);
  fake.deliver(env("ready", { protocols: [1], studioVersion: "x" }), APP);
  fake.deliver(env("init", { token: "" }), APP);
  assert.equal(received.length, 0);
});

test("an init with an unsupported protocol gets an error and pins nothing", () => {
  const fake = fakeWindow();
  const { instance, received } = bridge(fake);
  fake.posted.length = 0;
  fake.deliver(env("init", { token: "t" }, 9), APP);
  assert.equal(received.length, 0);
  assert.equal(instance.origin(), undefined);
  assert.equal(fake.posted.length, 1);
  assert.equal(fake.posted[0].origin, APP);
  assert.equal(fake.posted[0].message.kind, "error");
  assert.equal(fake.posted[0].message.code, "protocol_unsupported");
});

test("the allowlist comes from the meta tag the server injects", () => {
  const document = {
    querySelector: () => ({ getAttribute: () => " nylorun://localhost  http://nylorun.localhost " }),
  };
  assert.deepEqual(frameAncestorsFrom(document), [APP, OTHER]);
  assert.deepEqual(frameAncestorsFrom({ querySelector: () => null }), []);
});

function sessionHarness({ start = 1_000_000 } = {}) {
  const clock = { now: start };
  const timers = [];
  const posted = [];
  const calls = [];
  const responses = [];
  const session = createEmbedSession({
    now: () => clock.now,
    post: (message) => posted.push(message),
    setTimer: (run, ms) => {
      const timer = { run, at: clock.now + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.done = true;
    },
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses.shift();
      return next ? next(String(input), init) : Response.json({ ok: true });
    },
  });
  const advance = (ms) => {
    clock.now += ms;
    for (const timer of timers)
      if (!timer.done && timer.at <= clock.now) {
        timer.done = true;
        timer.run();
      }
  };
  const issue = (token, ttl = 60 * 60 * 1000) => () =>
    Response.json(
      {
        sessionToken: token,
        tenant: "ten_1",
        subject: "user_1",
        expiresAt: new Date(clock.now + ttl).toISOString(),
      },
      { status: 201 },
    );
  return { clock, session, posted, calls, responses, advance, issue };
}

test("a redeemed session adds its bearer, posts session, and asks for a token before expiry", async () => {
  const h = sessionHarness();
  assert.equal(h.session.status(), "waiting");
  h.responses.push(h.issue("v2.a.sig"));
  await h.session.redeem("login-1");
  const redeemCall = h.calls[0];
  assert.equal(redeemCall.url, "/_studio/sessions");
  assert.equal(redeemCall.init.credentials, "omit");
  assert.deepEqual(JSON.parse(redeemCall.init.body), { token: "login-1" });
  assert.equal(h.session.status(), "ready");
  assert.equal(h.posted[0].kind, "session");
  assert.equal(h.posted[0].tenant, "ten_1");

  await h.session.fetch("/_studio/hello");
  const call = h.calls.at(-1);
  assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer v2.a.sig");
  assert.equal(call.init.credentials, "omit");

  h.advance(60 * 60 * 1000 - REFRESH_BEFORE_MS - 1);
  assert.equal(h.posted.some((m) => m.kind === "token.expiring"), false);
  h.advance(1);
  assert.equal(h.posted.at(-1).kind, "token.expiring");
});

test("requests wait for the first session, and fail if none arrives in time", async () => {
  const h = sessionHarness();
  const pending = h.session.fetch("/_studio/hello");
  h.responses.push(h.issue("v2.b.sig"));
  await h.session.redeem("login-1");
  await pending;
  assert.equal(new Headers(h.calls.at(-1).init.headers).get("authorization"), "Bearer v2.b.sig");

  const late = sessionHarness();
  const waiting = late.session.fetch("/_studio/hello");
  late.advance(30 * 1000);
  await assert.rejects(waiting, EmbedSessionUnavailableError);
  assert.equal(late.session.status(), "failed");
  late.session.retry();
  assert.equal(late.posted.at(-1).kind, "token.expiring");
});

test("a 401 asks the embedder for a new token and retries once", async () => {
  const h = sessionHarness();
  h.responses.push(h.issue("v2.old.sig"));
  await h.session.redeem("login-1");
  h.responses.push(() => new Response("{}", { status: 401 }));
  const result = h.session.fetch("/_studio/tenants/ten_1/runtime/v1/agents");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.session.status(), "reconnecting");
  assert.equal(h.posted.at(-1).kind, "token.expiring");
  h.responses.push(h.issue("v2.new.sig"));
  await h.session.redeem("login-2");
  const response = await result;
  assert.equal(response.status, 200);
  assert.equal(new Headers(h.calls.at(-1).init.headers).get("authorization"), "Bearer v2.new.sig");
  assert.equal(h.session.status(), "ready");
});

test("a refused login token is reported and leaves no session", async () => {
  const h = sessionHarness();
  h.responses.push(() => Response.json({ code: "token_invalid" }, { status: 401 }));
  await h.session.redeem("used");
  assert.equal(h.session.status(), "waiting");
  assert.deepEqual(h.posted.map((m) => [m.kind, m.code]), [["error", "token_invalid"]]);
});
