import { describe, expect, it } from "vitest";
import { signingKeysCommand } from "../../src/client/signing-keys.js";
import { CliError } from "../../src/errors.js";
import { fakeFetch, json, temporaryHome, testDeps } from "../stack/support.js";

const URL = "http://runtime.test";
const KEY = "cd".repeat(32);

/** Deps on a remote installation whose Management API answers the signing-key routes. */
async function remote() {
  const fetch = fakeFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url === `${URL}/v1/tenant/signing-keys` && method === "GET") return json({ keys: [] });
    if (url === `${URL}/v1/tenant/signing-keys/rotate` && method === "POST") return json({ keys: [] });
    if (url.startsWith(`${URL}/v1/tenant/signing-keys/`) && method === "POST")
      return json({ kid: url.split("/").at(-2), state: "revoked" });
    return undefined;
  });
  const deps = testDeps(await temporaryHome(), { fetch });
  return Object.assign(deps, {
    env: { ...deps.env, NYLORUN_RUNTIME_URL: URL, NYLORUN_MANAGEMENT_KEY: KEY },
    fetch,
  });
}

describe("nylorun tenant signing-keys", () => {
  it("lists, rotates and revokes signing keys with the management key", async () => {
    const deps = await remote();
    expect(await signingKeysCommand(deps, ["list"])).toBe(0);
    expect(await signingKeysCommand(deps, ["rotate", "--force"])).toBe(0);
    expect(await signingKeysCommand(deps, ["revoke", "sk_x"])).toBe(0);
    const requests = deps.fetch.requests.map(({ url, init }) => [
      init?.method ?? "GET",
      url.slice(URL.length),
      init?.body === undefined ? undefined : JSON.parse(String(init.body)).force,
      new Headers(init?.headers).get("authorization"),
    ]);
    expect(requests).toEqual([
      ["GET", "/v1/tenant/signing-keys", undefined, `Bearer ${KEY}`],
      ["POST", "/v1/tenant/signing-keys/rotate", true, `Bearer ${KEY}`],
      ["POST", "/v1/tenant/signing-keys/sk_x/revoke", undefined, `Bearer ${KEY}`],
    ]);
    expect(JSON.parse(deps.lines.at(-1)!)).toEqual({ kid: "sk_x", state: "revoked" });
  });

  it("answers usage errors with exit code 2, before any request", async () => {
    const deps = await remote();
    for (const args of [[], ["rotate", "now"], ["revoke"], ["nope"], ["list", "--force"]]) {
      const error = await signingKeysCommand(deps, args).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
    expect(deps.fetch.requests).toEqual([]);
  });
});
