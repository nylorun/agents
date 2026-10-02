import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { decodeCursor, encodeCursor } from "../src/record/index.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const headers = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

type Event = { type: string; cursor: string };

async function say(url: string, content: string) {
  const response = await fetch(`${url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "message",
      requestId: content,
      idempotencyKey: content,
      content,
    }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { cursor: string };
}

async function history(url: string, cursor?: string) {
  const query = cursor ? `?cursor=${cursor}` : "";
  const response = await fetch(`${url}/v1/sessions/s1/items${query}`, {
    headers,
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { items: Event[]; cursor: string | null };
}

async function settled(url: string, count: number): Promise<Event[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { items } = await history(url);
    if (items.filter((e) => e.type === "turn.completed").length >= count)
      return items;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("turn did not complete");
}

/** Reads SSE frames until `done` holds for the events seen so far. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  done: (events: Event[]) => boolean
): Promise<Event[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Event[] = [];
  let text = "";
  while (!done(events)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = text.indexOf("\n\n")) >= 0) {
      const frame = text.slice(0, end);
      text = text.slice(end + 2);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)) as Event);
    }
  }
  await reader.cancel();
  return events;
}

it("numbers events per session and replays SSE after a cursor, then follows live", async () => {
  const runtime = await startTestTenant({ applicationKey: APP });
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    await fetch(`${runtime.url}/v1/agents/bot`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        requestId: "agent",
        manifest: agent.manifest,
        implementationVersion: "dev",
      }),
    });
    await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        requestId: "session",
        agentId: "bot",
        ownerUserId: "ada",
      }),
    });
    const accepted = await say(runtime.url, "first");
    expect(accepted.cursor).toBe(encodeCursor("s1", 0));
    const first = await settled(runtime.url, 1);
    expect(first.map((e) => decodeCursor("s1", e.cursor))).toEqual(
      first.map((_, i) => i)
    );
    const tail = await history(runtime.url, first[0]!.cursor);
    expect(tail.items).toEqual(first.slice(1));
    expect(tail.cursor).toBe(first.at(-1)!.cursor);
    expect(
      (
        await fetch(`${runtime.url}/v1/sessions/s1/items?cursor=bogus`, {
          headers,
        })
      ).status
    ).toBe(400);

    const stream = await fetch(
      `${runtime.url}/v1/sessions/s1/events?cursor=${first[0]!.cursor}`,
      { headers }
    );
    expect(stream.status).toBe(200);
    const reading = readStream(
      stream.body!,
      (events) => events.filter((e) => e.type === "turn.completed").length >= 2
    );
    await say(runtime.url, "second");
    const streamed = await reading;
    const seqs = streamed.map((e) => decodeCursor("s1", e.cursor));
    // The replay starts after the cursor, and live events follow with no gap or duplicate.
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(streamed.slice(0, first.length - 1)).toEqual(first.slice(1));
  } finally {
    await runtime.close();
  }
});
