import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base58btc,
  ensureIdentityKey,
  generateIdentityPem,
  identityPublicKey,
} from "../../src/stack/restate-identity.js";
import { temporaryHome } from "./support.js";

/**
 * Independent base58btc: the number as a BigInt, then leading zero bytes as
 * "1". Deliberately a different algorithm from the one under test.
 */
function base58Reference(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = alphabet[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/**
 * Verified against a real Restate server: `docker.restate.dev/restatedev/restate:1.7.12`
 * with this PEM as RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE
 * logs "Loaded request identity key" with this `kid`.
 */
const RESTATE_VECTOR = {
  pem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMcoQgQeU+ZVIXPH9VEJPNg5zs
-----END PRIVATE KEY-----
`,
  kid: "publickeyv1_9X4RmZSyRwtembhvBJbbemS2epiX6hHJT9yt2ABTh8SR",
};

describe("base58btc", () => {
  it("encodes known vectors", () => {
    expect(base58btc(new Uint8Array())).toBe("");
    expect(base58btc(Uint8Array.of(0))).toBe("1");
    expect(base58btc(Uint8Array.of(0, 0, 1))).toBe("112");
    expect(base58btc(Uint8Array.of(57))).toBe("z");
    expect(base58btc(Uint8Array.of(58))).toBe("21");
    // The classic "Hello World!" vector.
    expect(base58btc(Buffer.from("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
  });

  it("matches an independent implementation on random and zero-led inputs", () => {
    for (let round = 0; round < 200; round += 1) {
      const bytes = randomBytes(32);
      if (round % 10 === 0) bytes.fill(0, 0, round % 4);
      expect(base58btc(bytes)).toBe(base58Reference(bytes));
    }
  });
});

describe("identityPublicKey", () => {
  it("matches the key id Restate logs for the same PEM", () => {
    expect(identityPublicKey(RESTATE_VECTOR.pem)).toBe(RESTATE_VECTOR.kid);
  });

  it("encodes the raw 32-byte Ed25519 public key of generated PEMs", () => {
    for (let round = 0; round < 20; round += 1) {
      const pem = generateIdentityPem();
      expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/);
      const der = createPublicKey(createPrivateKey(pem)).export({ format: "der", type: "spki" });
      // SPKI for Ed25519 is a fixed 12-byte header followed by the raw key.
      const raw = der.subarray(der.length - 32);
      expect(identityPublicKey(pem)).toBe(`publickeyv1_${base58Reference(raw)}`);
    }
  });

  it("refuses keys that are not Ed25519", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => identityPublicKey(pem)).toThrow(/not an Ed25519/);
    expect(() => identityPublicKey("garbage")).toThrow(/not an Ed25519 PKCS#8 PEM/);
  });
});

describe("ensureIdentityKey", () => {
  it("creates the PEM once with mode 0600 and keeps it afterwards", async () => {
    const home = await temporaryHome();
    await mkdir(home, { recursive: true });
    const path = join(home, "restate-identity.pem");
    const writes: string[] = [];
    const write = async (target: string, text: string, mode: number) => {
      writes.push(target);
      await writeFile(target, text, { mode });
    };
    const first = await ensureIdentityKey(path, write);
    expect(first.created).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const second = await ensureIdentityKey(path, write);
    expect(second).toEqual({ publicKey: first.publicKey, created: false });
    expect(writes).toEqual([path]);
    expect(identityPublicKey(await readFile(path, "utf8"))).toBe(first.publicKey);
  });
});
