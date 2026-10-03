import { expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { createClient } from "../src/client.js";

const URL_ = "http://127.0.0.1:8787";

function fake() {
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const client = createClient({
    url: URL_,
    key: "secret",
    fetch: async (url, init) => {
      if (String(url).endsWith("/health"))
        return Response.json({ status: "ok", protocol: { ...HOST_PROTOCOL } });
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      if (String(url).includes("/links"))
        return Response.json({
          path: "/v1/artifact-links/a.b.c",
          artifactId: "af_1",
          version: 1,
          expiresAt: "2026-10-03T00:00:00.000Z",
        });
      if (String(url).endsWith("/content")) return new Response("bytes");
      return Response.json({ artifacts: [], artifact: {}, version: {} }, { status: 201 });
    },
  });
  return { client, calls };
}

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
