/**
 * Request bodies and aborts as Tenant routes see them: a body read once and decoded whole, and
 * the request's signal aborting when the caller leaves after sending it (what sandbox tool
 * calls stop on).
 */
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { readText } from "../../src/api/http/body.js";
import { HttpError } from "../../src/tenant/http.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Serves `fetch` as the Runtime does, and returns the port. */
async function serve(fetch: (request: Request) => Promise<Response>): Promise<number> {
  const server = createServer(getRequestListener(fetch, { overrideGlobalObjects: false }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** POSTs `chunks`, each written separately. */
function post(port: number, chunks: Buffer[]) {
  const req = request({ port, host: "127.0.0.1", method: "POST", path: "/" });
  req.on("error", () => {});
  void (async () => {
    for (const chunk of chunks) {
      req.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    req.end();
  })();
  return req;
}

it("readText keeps a character whose bytes arrive in different chunks", async () => {
  let text: string | undefined;
  const port = await serve(async (request) => {
    text = await readText(request);
    return new Response(null, { status: 204 });
  });
  const bytes = Buffer.from("héllo ✓", "utf8");
  const split = bytes.indexOf(0xa9); // inside "é" (c3 a9)
  const req = post(port, [bytes.subarray(0, split), bytes.subarray(split)]);
  await new Promise((resolve) => req.on("response", resolve));
  expect(text).toBe("héllo ✓");
});

it("readText refuses a body over 1 MiB", async () => {
  let error: unknown;
  const port = await serve(async (request) => {
    await readText(request).catch((caught) => void (error = caught));
    return new Response(null, { status: 204 });
  });
  const req = post(port, [Buffer.alloc(1024 * 1024 + 1, 0x61)]);
  await new Promise((resolve) => req.on("response", resolve));
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(413);
});

it("the request's signal aborts when the caller leaves after its body was read", async () => {
  let signal: AbortSignal | undefined;
  const read = Promise.withResolvers<void>();
  const port = await serve(async (request) => {
    await readText(request);
    signal = request.signal;
    read.resolve();
    await new Promise((resolve) => signal!.addEventListener("abort", resolve));
    return new Response(null, { status: 204 });
  });
  const req = post(port, [Buffer.from("{}")]);
  await read.promise;
  expect(signal!.aborted).toBe(false);
  req.destroy();
  await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve()));
  expect(signal!.aborted).toBe(true);
});

it("the request's signal does not abort for a finished answer", async () => {
  let signal: AbortSignal | undefined;
  const port = await serve(async (request) => {
    await readText(request);
    signal = request.signal;
    return new Response("done");
  });
  const req = post(port, [Buffer.from("{}")]);
  const response = await new Promise<IncomingMessage>((resolve) => req.on("response", resolve));
  response.resume();
  await new Promise((resolve) => response.on("end", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(signal!.aborted).toBe(false);
});
