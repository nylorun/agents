/**
 * The Runtime's requests to Action endpoints (`tenant/outbound.ts`): the Host's address policy,
 * no redirects, a bounded answer, and whether a failed request reached the endpoint.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { guardedFetch, isPrivateAddress, OutboundFailed, OutboundRefused, post, refusal } from "../src/tenant/outbound.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

const signal = () => AbortSignal.timeout(5_000);

describe("addresses", () => {
  it("knows private, loopback, link-local and mapped addresses", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "example.com"])
      expect(isPrivateAddress(address), address).toBe(false);
  });

  it("refuses by the Host's policy before connecting", () => {
    expect(refusal(new URL("http://example.com/a"), {})).toBeUndefined();
    expect(refusal(new URL("http://example.com/a"), { allowHttp: false })).toMatch(/only https/);
    expect(refusal(new URL("https://10.0.0.1/a"), { privateAddresses: "refuse" })).toMatch(/private addresses/);
    expect(refusal(new URL("https://[::1]/a"), { privateAddresses: "refuse" })).toMatch(/private addresses/);
    expect(refusal(new URL("https://10.0.0.1/a"), { privateAddresses: "allow" })).toBeUndefined();
  });

  it("refuses a name that resolves only to private addresses, as not sent", async () => {
    const port = await serve((_req, res) => res.end("{}"));
    const result = await post(`http://localhost:${port}/a`, "{}", {}, { policy: { privateAddresses: "refuse" }, signal: signal() });
    expect(result).toMatchObject({ kind: "not_sent", code: "ENDPOINT_ADDRESS_REFUSED" });
  });
});

describe("requests", () => {
  it("POSTs JSON with the given headers and returns the answer", async () => {
    let seen: { method?: string; headers?: Record<string, unknown>; body?: string } = {};
    const port = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { method: req.method, headers: req.headers, body };
        res.writeHead(200, { "x-answer": "yes" }).end('{"ok":true}');
      });
    });
    const result = await post(`http://localhost:${port}/a`, '{"x":1}', { "nylorun-signature": "t" }, { policy: {}, signal: signal() });
    expect(result).toMatchObject({ kind: "response", status: 200, headers: { "x-answer": "yes" } });
    expect(result.kind === "response" && result.body.toString()).toBe('{"ok":true}');
    expect(seen).toMatchObject({
      method: "POST",
      body: '{"x":1}',
      headers: { "nylorun-signature": "t", "content-type": "application/json", host: `localhost:${port}` },
    });
  });

  it("does not follow redirects", async () => {
    const port = await serve((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/" }).end());
    expect(await post(`http://127.0.0.1:${port}/a`, "{}", {}, { policy: {}, signal: signal() })).toMatchObject({
      kind: "response",
      status: 302,
    });
  });

  it("stops reading an answer that is too large", async () => {
    const port = await serve((_req, res) => res.end("x".repeat(2048)));
    expect(
      await post(`http://127.0.0.1:${port}/a`, "{}", {}, { policy: {}, signal: signal(), maxResponseBytes: 1024 }),
    ).toEqual({ kind: "too_large", status: 200 });
  });

  it("tells a refused connection (not sent) from a request cut off after sending (lost)", async () => {
    const closed = await serve(() => {});
    const port = closed;
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await post(`http://127.0.0.1:${port}/a`, "{}", {}, { policy: {}, signal: signal() })).toMatchObject({
      kind: "not_sent",
      code: "ECONNREFUSED",
    });
    const cut = await serve((req) => req.on("data", () => req.socket.destroy()));
    expect(await post(`http://127.0.0.1:${cut}/a`, "{}", {}, { policy: {}, signal: signal() })).toMatchObject({
      kind: "lost",
    });
    const slow = await serve(() => {});
    expect(
      await post(`http://127.0.0.1:${slow}/a`, "{}", {}, { policy: {}, signal: AbortSignal.timeout(200) }),
    ).toMatchObject({ kind: "lost", code: "ABORTED" });
  });

  it("maps localhost to the Docker host in the local stack", async () => {
    const result = await post("http://localhost:1/a", "{}", {}, {
      policy: { loopback: "docker-host" },
      signal: AbortSignal.timeout(2_000),
    });
    // host.docker.internal does not resolve outside Docker, so nothing was sent.
    expect(result.kind).toBe("not_sent");
  });
});

describe("guardedFetch (F9 C2)", () => {
  it("sends a form or JSON body with its headers and answers a Response", async () => {
    const seen: { method?: string; type?: string; body: string; host?: string }[] = [];
    const port = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, type: req.headers["content-type"], body, host: req.headers.host });
        res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] }).end('{"ok":true}');
      });
    });
    const fetchFn = guardedFetch({});
    const form = await fetchFn(`http://localhost:${port}/token`, {
      method: "POST",
      headers: new Headers({ accept: "application/json" }),
      body: new URLSearchParams({ grant_type: "x", code: "c" }),
    });
    expect(form.status).toBe(201);
    expect(await form.json()).toEqual({ ok: true });
    expect(form.headers.get("set-cookie")).toContain("a=1");
    const get = await fetchFn(new URL(`http://localhost:${port}/meta`), { headers: { "mcp-protocol-version": "x" } });
    expect(get.ok).toBe(true);
    expect(seen).toEqual([
      { method: "POST", type: "application/x-www-form-urlencoded;charset=UTF-8", body: "grant_type=x&code=c", host: `localhost:${port}` },
      { method: "GET", body: "", host: `localhost:${port}` },
    ]);
  });

  it("refuses private addresses, literal or resolved, with OutboundRefused and connects to nothing", async () => {
    let hits = 0;
    const port = await serve((_req, res) => {
      hits += 1;
      res.end("{}");
    });
    const fetchFn = guardedFetch({ privateAddresses: "refuse" });
    await expect(fetchFn(`http://127.0.0.1:${port}/a`)).rejects.toBeInstanceOf(OutboundRefused);
    await expect(fetchFn(`http://localhost:${port}/a`)).rejects.toBeInstanceOf(OutboundRefused);
    await expect(guardedFetch({ allowHttp: false })(`http://localhost:${port}/a`)).rejects.toThrow(/only https/);
    expect(hits).toBe(0);
  });

  it("never follows a redirect, and bounds the answer", async () => {
    const port = await serve((req, res) => {
      if (req.url === "/redirect") res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      else res.end("x".repeat(2048));
    });
    await expect(guardedFetch({})(`http://localhost:${port}/redirect`)).rejects.toMatchObject({
      name: "OutboundFailed",
      code: "REDIRECT",
    });
    await expect(guardedFetch({}, { maxResponseBytes: 1024 })(`http://localhost:${port}/big`)).rejects.toBeInstanceOf(
      OutboundFailed,
    );
    await expect(guardedFetch({})(`http://localhost:1/closed`)).rejects.toBeInstanceOf(OutboundFailed);
  });

  it("streams an answer that stays open, unbounded, when asked to (MCP)", async () => {
    let finish!: () => void;
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("x".repeat(2048));
      finish = () => res.end("done");
    });
    const answer = await guardedFetch({}, { stream: true, maxResponseBytes: 1024 })(`http://localhost:${port}/sse`);
    expect(answer.headers.get("content-type")).toBe("text/event-stream");
    const reader = answer.body!.getReader();
    let text = "";
    while (text.length < 2048) text += new TextDecoder().decode((await reader.read()).value);
    finish();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      text += new TextDecoder().decode(chunk.value);
    expect(text.endsWith("done")).toBe(true);
  });
});
