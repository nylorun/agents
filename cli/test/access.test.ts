import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagementClient } from "@nylorun/admin";
import { accessCommand } from "../src/access/commands.js";
import { CliError } from "../src/errors.js";

function stub() {
  const calls: [string, ...unknown[]][] = [];
  const client = {
    signingKeys: {
      list: async () => (calls.push(["list"]), []),
      rotate: async (options: unknown) => (calls.push(["rotate", options]), []),
      revoke: async (kid: string) => (calls.push(["revoke", kid]), { id: kid }),
    },
  } as unknown as ManagementClient;
  return { calls, run: (args: string[]) => accessCommand(args, async () => client) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nylo access", () => {
  it("lists, rotates and revokes signing keys", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, run } = stub();
    await run(["signing-keys", "list"]);
    await run(["signing-keys", "rotate", "--force"]);
    await run(["signing-keys", "revoke", "sk_x"]);
    expect(calls).toEqual([["list"], ["rotate", { force: true }], ["revoke", "sk_x"]]);
  });

  it("names the removed policy, browser key, revocation and token commands (protocol 7)", async () => {
    const { calls, run } = stub();
    for (const args of [["policy", "get"], ["keys", "list"], ["revoke", "app:42"], ["token", "--subject", "a"]]) {
      const error = await run(args).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
      expect((error as Error).message).toMatch(/was removed.*identity file.*operator key/s);
    }
    expect(calls).toEqual([]);
  });

  it("answers usage errors with exit code 2", async () => {
    const { run } = stub();
    for (const args of [["signing-keys"], ["signing-keys", "rotate", "now"], ["nope"]]) {
      const error = await run(args).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});
