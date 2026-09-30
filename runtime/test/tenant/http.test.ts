/**
 * The Tenant routes' request plumbing: body reading and the client-abort signal, over real
 * sockets.
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { HttpError, readText, requestAborted } from "../../src/tenant/http.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<number> {
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** POSTs `chunks`, each written separately, and returns the connection's request. */
function post(port: number, chunks: Buffer[]) {
  const req = request({ port, host: "127.0.0.1", method: "POST", path: "/" });
  req.on("error", () => {});
  (async () => {
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
  const port = await serve(async (req, res) => {
    text = await readText(req);
    res.end();
  });
  const bytes = Buffer.from("héllo ✓", "utf8");
  const split = bytes.indexOf(0xa9); // inside "é" (c3 a9)
  const req = post(port, [bytes.subarray(0, split), bytes.subarray(split)]);
  await new Promise((resolve) => req.on("response", resolve));
  expect(text).toBe("héllo ✓");
});

it("readText refuses a body over 1 MiB", async () => {
  let error: unknown;
  const port = await serve(async (req, res) => {
    await readText(req).catch((caught) => void (error = caught));
    res.end();
  });
  const req = post(port, [Buffer.alloc(1024 * 1024 + 1, 0x61)]);
  await new Promise((resolve) => req.on("response", resolve));
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(413);
});

it("requestAborted aborts when the client leaves after its body was read", async () => {
  let signal: AbortSignal | undefined;
  const read = Promise.withResolvers<void>();
  const port = await serve(async (req, res) => {
    await readText(req);
    signal = requestAborted(res);
    read.resolve();
  });
  const req = post(port, [Buffer.from("{}")]);
  await read.promise;
  expect(signal!.aborted).toBe(false);
  req.destroy();
  await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve()));
  expect(signal!.aborted).toBe(true);
});

it("requestAborted does not abort a response that finished", async () => {
  let signal: AbortSignal | undefined;
  const port = await serve(async (req, res) => {
    await readText(req);
    signal = requestAborted(res);
    res.end("done");
  });
  const req = post(port, [Buffer.from("{}")]);
  const response = await new Promise<IncomingMessage>((resolve) => req.on("response", resolve));
  response.resume();
  await new Promise((resolve) => response.on("end", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(signal!.aborted).toBe(false);
});
