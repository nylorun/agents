import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsClient } from "@nylorun/agents";
import { accessCommand, STARTER_POLICY } from "../src/access/commands.js";
import { CliError } from "../src/errors.js";

function stub() {
  const calls: [string, ...unknown[]][] = [];
  const client = {
    access: {
      getPolicy: async () => (calls.push(["getPolicy"]), STARTER_POLICY),
      putPolicy: async (policy: unknown) => (calls.push(["putPolicy", policy]), policy),
      revokeSubject: async (subject: string) => (
        calls.push(["revokeSubject", subject]), { subject, epoch: 1 }
      ),
      publishableKeys: {
        create: async (options: unknown) => (calls.push(["createKey", options]), { key: "k" }),
        update: async (id: string, options: unknown) => (calls.push(["updateKey", id, options]), {}),
        revoke: async (id: string) => (calls.push(["revokeKey", id]), {}),
        list: async () => (calls.push(["listKeys"]), []),
      },
      signingKeys: {
        list: async () => (calls.push(["list"]), []),
        rotate: async (options: unknown) => (calls.push(["rotate", options]), []),
        revoke: async (kid: string) => (calls.push(["revoke", kid]), { id: kid }),
      },
    },
    tokens: {
      create: async (options: unknown) => (calls.push(["create", options]), { token: "t" }),
    },
  } as unknown as AgentsClient;
  return { calls, run: (args: string[]) => accessCommand(args, async () => client) };
}

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("nylo access", () => {
  it("writes the starter policy and reads it back", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, run } = stub();
    await run(["policy", "init"]);
    await run(["policy", "get"]);
    expect(calls).toEqual([["putPolicy", STARTER_POLICY], ["getPolicy"]]);
  });

  it("sets the policy from a file, as printed by policy get or bare", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), "nylo-access-"));
    dirs.push(dir);
    const wrapped = join(dir, "wrapped.json");
    const bare = join(dir, "bare.json");
    await writeFile(wrapped, JSON.stringify({ policy: STARTER_POLICY }));
    await writeFile(bare, JSON.stringify(STARTER_POLICY));
    const { calls, run } = stub();
    await run(["policy", "set", wrapped]);
    await run(["policy", "set", bare]);
    expect(calls).toEqual([
      ["putPolicy", STARTER_POLICY],
      ["putPolicy", STARTER_POLICY],
    ]);
  });

  it("rotates, revokes keys and subjects, and mints a token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, run } = stub();
    await run(["signing-keys", "rotate", "--force"]);
    await run(["signing-keys", "revoke", "sk_x"]);
    await run(["revoke", "app:42"]);
    await run(["token", "--subject", "app:42", "--role", "user", "--ttl", "300"]);
    expect(calls).toEqual([
      ["rotate", { force: true }],
      ["revoke", "sk_x"],
      ["revokeSubject", "app:42"],
      ["create", { subject: "app:42", role: "user", ttlSeconds: 300 }],
    ]);
  });

  it("manages publishable keys", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, run } = stub();
    await run(["keys", "create", "--name", "web", "--origin", "https://app.example.com", "--origin", "http://localhost:*"]);
    await run(["keys", "set-origins", "pk_1", "https://other.example.com"]);
    await run(["keys", "set-origins", "pk_1"]);
    await run(["keys", "revoke", "pk_1"]);
    await run(["keys", "list"]);
    expect(calls).toEqual([
      ["createKey", { name: "web", origins: ["https://app.example.com", "http://localhost:*"] }],
      ["updateKey", "pk_1", { origins: ["https://other.example.com"] }],
      ["updateKey", "pk_1", { origins: [] }],
      ["revokeKey", "pk_1"],
      ["listKeys"],
    ]);
  });

  it("answers usage errors with exit code 2", async () => {
    const { run } = stub();
    for (const args of [["policy"], ["token", "--subject", "a"], ["revoke"], ["nope"]]) {
      const error = await run(args).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});
