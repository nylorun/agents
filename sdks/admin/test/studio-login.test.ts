import { describe, expect, it } from "vitest";
import { AdminError, mintStudioLoginToken } from "../src/index.js";

const ADMIN_KEY = "a".repeat(64);
const TENANT = "tn_00000000000000000000000001";

function recorder(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("mintStudioLoginToken", () => {
  it("sends the admin key and the Tenant, and returns the parsed token", async () => {
    const token = {
      token: "t".repeat(43),
      url: "http://localhost:4161/login?token=x",
      expiresAt: "2026-10-01T00:02:00.000Z",
      tenant: TENANT,
      subject: "user_1",
    };
    const { calls, fetcher } = recorder(() => Response.json(token, { status: 201 }));
    const minted = await mintStudioLoginToken({
      studioUrl: "http://localhost:4161",
      adminKey: ADMIN_KEY,
      tenant: TENANT,
      subject: "user_1",
      fetch: fetcher,
    });
    expect(minted).toEqual(token);
    expect(calls[0]!.url).toBe("http://localhost:4161/_studio/login-tokens");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${ADMIN_KEY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ tenant: TENANT, subject: "user_1" });
  });

  it("refuses a bad request before sending it", async () => {
    const { calls, fetcher } = recorder(() => Response.json({}));
    await expect(
      mintStudioLoginToken({ studioUrl: "http://localhost:4161", adminKey: ADMIN_KEY, tenant: "../x", fetch: fetcher }),
    ).rejects.toBeInstanceOf(AdminError);
    expect(calls).toHaveLength(0);
  });

  it("reports a wrong admin key, an old Studio and an unreachable one", async () => {
    const denied = recorder(() => Response.json({ message: "The admin key is required" }, { status: 401 }));
    await expect(
      mintStudioLoginToken({ studioUrl: "http://localhost:4161", adminKey: "x", fetch: denied.fetcher }),
    ).rejects.toMatchObject({ code: "host_rejected", status: 401, message: "The admin key is required" });
    // A Studio before Tenant-limited tokens answers without tenant and subject.
    const old = recorder(() =>
      Response.json({ token: "t", url: "u", expiresAt: "e" }, { status: 201 }),
    );
    await expect(
      mintStudioLoginToken({ studioUrl: "http://localhost:4161", adminKey: ADMIN_KEY, fetch: old.fetcher }),
    ).rejects.toMatchObject({ code: "incompatible_host" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      mintStudioLoginToken({ studioUrl: "http://localhost:4161", adminKey: ADMIN_KEY, fetch: down }),
    ).rejects.toMatchObject({ code: "connection_missing" });
  });
});
