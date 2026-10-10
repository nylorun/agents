import { expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { createClient } from "../src/client.js";

const URL_ = "http://127.0.0.1:8787";

function fake(features: readonly string[] = HOST_PROTOCOL.features) {
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const client = createClient({
    url: URL_,
    key: "secret",
    fetch: async (url, init) => {
      if (String(url).endsWith("/health"))
        return Response.json({ status: "ok", protocol: { ...HOST_PROTOCOL, features } });
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body,
        signal: init?.signal,
      });
      if (String(url).includes("/links"))
        return Response.json({
          path: "/v1/artifact-links/a.b.c",
          artifactId: "af_1",
          version: 1,
          expiresAt: "2026-10-03T00:00:00.000Z",
        });
      if (String(url).endsWith("/content")) return new Response("bytes");
      if (new URL(String(url)).searchParams.has("limit"))
        return Response.json({ artifacts: [], nextCursor: null });
      return Response.json({ artifacts: [], artifact: {}, version: {} }, { status: 201 });
    },
  });
  return { client, calls };
}

it("pages artifact metadata with default size, filters and cancellation, preserving legacy lists", async () => {
  const { client, calls } = fake();
  await client.artifacts.list();
  expect(await client.artifacts.page()).toEqual({ artifacts: [], nextCursor: null });
  const abort = new AbortController();
  await client.artifacts.page({
    limit: 2,
    cursor: "opaque",
    sessionId: "s 1",
    kind: "folder",
    labels: { team: "one", status: "a=b" },
    signal: abort.signal,
  });
  expect(calls.map((call) => call.url)).toEqual([
    `${URL_}/v1/artifacts`,
    `${URL_}/v1/artifacts?limit=50`,
    `${URL_}/v1/artifacts?limit=2&cursor=opaque&sessionId=s+1&kind=folder&label=team%3Done&label=status%3Da%3Db`,
  ]);
  expect(calls.every((call) => call.method === "GET" && call.body === undefined)).toBe(true);
  expect(calls[2]!.signal).toBe(abort.signal);
});

it("refuses artifact paging on older Hosts before making a list request", async () => {
  const { client, calls } = fake(
    HOST_PROTOCOL.features.filter((feature) => feature !== "artifact-reads"),
  );
  await expect(client.artifacts.page()).rejects.toThrow(/artifact-reads/);
  expect(calls).toEqual([]);
  expect(await client.artifacts.list()).toEqual([]);
});

it("uploads with the file's type, names it in the query, and sends parts", async () => {
  const { client, calls } = fake();
  await client.artifacts.upload(new Uint8Array([1, 2]), {
    name: "room photo.png",
    sessionId: "s 1",
    contentType: "image/png",
    labels: { kind: "photo" },
  });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe(`${URL_}/v1/artifacts?name=room+photo.png&sessionId=s+1&label=kind%3Dphoto`);
  expect(calls[0]!.headers.get("content-type")).toBe("image/png");

  await client.artifacts.upload("hello", { name: "a.txt" });
  expect(calls[1]!.headers.get("content-type")).toBe("text/plain; charset=utf-8");

  await client.session("s1").inputParts(
    [
      { type: "text", text: "What is this?" },
      { type: "file", artifactId: "af_1" },
    ],
    { idempotencyKey: "m1" },
  );
  expect(calls[2]!.url).toBe(`${URL_}/v1/sessions/s1/commands`);
  expect(calls[2]!.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(String(calls[2]!.body))).toMatchObject({
    type: "message",
    idempotencyKey: "m1",
    parts: [
      { type: "text", text: "What is this?" },
      { type: "file", artifactId: "af_1" },
    ],
  });
});

it("downloads a range and turns a link's path into a URL", async () => {
  const { client, calls } = fake();
  const response = await client.artifacts.download("af_1", { version: 2, range: { start: 3 } });
  expect(await response.text()).toBe("bytes");
  expect(calls[0]!.url).toBe(`${URL_}/v1/artifacts/af_1/versions/2/content`);
  expect(calls[0]!.headers.get("range")).toBe("bytes=3-");
  const link = await client.artifacts.link("af_1", { expiresIn: 60 });
  expect(link.url).toBe(`${URL_}/v1/artifact-links/a.b.c`);
  expect(JSON.parse(String(calls[1]!.body))).toEqual({ expiresIn: 60 });
});

it("reads a folder: tree, one file by path with Range, diff, zip and a file's link", async () => {
  const { client, calls } = fake();
  await client.artifacts.tree("af_1");
  expect(calls[0]!.url).toBe(`${URL_}/v1/artifacts/af_1/versions/latest/tree`);
  await client.artifacts.file("af_1", "app/src/main file.js", { version: 2, range: { start: 0, end: 9 } });
  expect(calls[1]!.url).toBe(`${URL_}/v1/artifacts/af_1/versions/2/files/app%2Fsrc%2Fmain%20file.js`);
  expect(calls[1]!.headers.get("range")).toBe("bytes=0-9");
  await client.artifacts.diff("af_1", { version: 3, from: 1 });
  expect(calls[2]!.url).toBe(`${URL_}/v1/artifacts/af_1/versions/3/diff?from=1`);
  await client.artifacts.zip("af_1", { version: 3 });
  expect(calls[3]!.url).toBe(`${URL_}/v1/artifacts/af_1/versions/3/zip`);
  await client.artifacts.link("af_1", { file: "app/index.html" });
  expect(JSON.parse(String(calls[4]!.body))).toEqual({ file: "app/index.html" });
});
