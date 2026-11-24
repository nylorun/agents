/** The CLI names itself to the Runtime (`Nylorun-Client: cli`), over any SDK's label. */
import { describe, expect, it } from "vitest";
import { CLIENT_LABEL, labelledFetch } from "../src/client-label.js";

describe("labelledFetch", () => {
  it("labels every request cli, replacing the SDK's sdk and keeping the other headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetch = labelledFetch(async (url, init) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response(null, { status: 204 });
    });
    await fetch("http://runtime:4000/v1/agents", { headers: { "Nylorun-Client": "sdk", authorization: "Bearer k" } });
    await fetch(new Request("http://runtime:4000/health"));
    expect(seen.map(({ url, headers }) => [url, headers.get("nylorun-client"), headers.get("authorization")])).toEqual([
      ["http://runtime:4000/v1/agents", "cli", "Bearer k"],
      ["http://runtime:4000/health", "cli", null],
    ]);
    expect(CLIENT_LABEL).toEqual({ "Nylorun-Client": "cli" });
  });
});
