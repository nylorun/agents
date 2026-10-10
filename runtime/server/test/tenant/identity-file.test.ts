/**
 * The identity file (Host feature `trusted-issuers`): what parses, and how a malformed file is
 * refused, naming the issuer and the field, before the Host boots. Keys it does not define are
 * ignored with a warning, so an older file (with `maxLifetime`, gone in protocol 9) still boots.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityFileError, parseIdentityFile } from "../../src/tenant/identity-file.js";
import { createTrustedIssuers, MAX_ISSUER_TOKEN_BYTES } from "../../src/tenant/issuers.js";

const BASE = {
  name: "keycloak",
  issuer: "https://sso.acme.dev/realms/eng",
  audience: "nylorun",
  jwks: "https://sso.acme.dev/realms/eng/protocol/openid-connect/certs",
  subject: '"u:{sub}"',
  scopes: "{ claim: nylorun_scopes }",
  allowedScopes: "[agents:read, sessions:own, sandboxes:write, studio]",
};

function file(overrides: Record<string, string | undefined> = {}, extra = ""): string {
  const entry = { ...BASE, ...overrides };
  const lines = Object.entries(entry)
    .filter(([, value]) => value !== undefined)
    .map(([key, value], index) => `${index === 0 ? "  - " : "    "}${key}: ${value}`);
  return `issuers:\n${lines.join("\n")}\n${extra}`;
}

function refusal(text: string): string {
  try {
    parseIdentityFile(text, "identity.yaml");
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityFileError);
    return (error as Error).message;
  }
  throw new Error("the file was accepted");
}

function pem(type: "rsa" | "ec" | "ed25519", options: Record<string, unknown> = {}): string {
  const { publicKey } = generateKeyPairSync(type as never, options as never) as unknown as {
    publicKey: { export(options: { type: string; format: string }): string };
  };
  return publicKey.export({ type: "spki", format: "pem" });
}

function keysBlock(pems: string[]): string {
  return `\n${pems
    .map((key) => `      - |\n${key.trim().split("\n").map((line) => `        ${line}`).join("\n")}`)
    .join("\n")}`;
}

describe("parseIdentityFile", () => {
  it("reads the issuers of the plan's example", () => {
    const [issuer] = parseIdentityFile(
      file({ agents: "[support]", sandboxes: '["{org_id}/*"]' }),
      "identity.yaml",
    );
    expect(issuer).toEqual({
      name: "keycloak",
      issuer: BASE.issuer,
      audience: "nylorun",
      jwks: BASE.jwks,
      subject: "u:{sub}",
      scopes: { claim: "nylorun_scopes" },
      allowedScopes: ["agents:read", "sessions:own", "sandboxes:write", "studio"],
      agents: ["support"],
      sandboxes: ["{org_id}/*"],
    });
  });

  it("defaults the subject, the scope claim and the allowed scopes", () => {
    const [issuer] = parseIdentityFile(
      file({ subject: undefined, scopes: undefined, allowedScopes: undefined }),
    );
    expect(issuer).toMatchObject({
      subject: "{sub}",
      scopes: { claim: "scope" },
      allowedScopes: ["agents:read", "sessions:own", "sandboxes:write"],
    });
  });

  it("ignores keys it does not define, with a warning naming each", () => {
    const warnings: string[] = [];
    const [issuer] = parseIdentityFile(file({ maxLifetime: "15m", typo: "1" }, "extra: true\n"), "identity.yaml", {
      warn: (message) => warnings.push(message),
    });
    expect(issuer).not.toHaveProperty("maxLifetime");
    expect(issuer).not.toHaveProperty("typo");
    expect(warnings).toEqual([
      "identity.yaml: the file: ignored `extra`, which the identity file does not define",
      "identity.yaml: issuer keycloak: ignored `maxLifetime`, `typo`, which the identity file does not define",
    ]);
    // Without a listener, the file still parses.
    expect(parseIdentityFile(file({ maxLifetime: "soon" }))).toHaveLength(1);
  });

  it("reads static keys of each accepted kind", () => {
    const [issuer] = parseIdentityFile(
      file({
        jwks: undefined,
        keys: keysBlock([
          pem("rsa", { modulusLength: 2048 }),
          pem("ec", { namedCurve: "P-256" }),
          pem("ed25519"),
        ]),
        scopes: "{ fixed: [sessions:own] }",
      }),
    );
    expect(issuer!.keys!.map((key) => key.alg)).toEqual(["RS256", "ES256", "EdDSA"]);
  });

  it("accepts an empty list, and an empty file", () => {
    expect(parseIdentityFile("issuers: []\n")).toEqual([]);
    expect(refusal("")).toContain("issuers");
  });

  it("refuses a subject template without a claim", () => {
    const message = refusal(file({ subject: '"everyone"' }));
    expect(message).toContain("identity.yaml");
    expect(message).toContain("issuer keycloak");
    expect(message).toContain("subject");
  });

  it("names the issuer and the field of each mistake", () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ allowedScopes: "[agents:write]" }, "allowedScopes"],
      [{ allowedScopes: "[tenant:settings]" }, "allowedScopes"],
      [{ allowedScopes: "[vaults:own]" }, "allowedScopes"],
      [{ allowedScopes: "[sessions:own]", scopes: "{ fixed: [agents:read] }" }, "scopes.fixed"],
      [{ scopes: "{ claim: a, fixed: [] }" }, "scopes"],
      [{ jwks: "ftp://sso.acme.dev/certs" }, "jwks"],
      [{ jwks: undefined }, "jwks or keys"],
      [{ keys: keysBlock([pem("ed25519")]) }, "jwks or keys"],
      [{ keys: keysBlock([pem("rsa", { modulusLength: 1024 })]), jwks: undefined }, "keys[0]"],
      [{ keys: keysBlock([pem("ec", { namedCurve: "P-384" })]), jwks: undefined }, "keys[0]"],
      [{ subject: '"u:{sub"' }, "subject"],
      [{ sandboxes: '["{org}/../x"]' }, "sandboxes"],
      [{ sandboxes: `[${Array.from({ length: 17 }, (_, i) => `"s${i}"`).join(", ")}]` }, "sandboxes"],
      [{ issuer: "urn:nylorun:tenant:tn_x" }, "issuer"],
      [{ audience: undefined }, "audience"],
    ];
    for (const [overrides, field] of cases) {
      const message = refusal(file(overrides));
      expect(message, JSON.stringify(overrides)).toContain("issuer keycloak");
      expect(message, JSON.stringify(overrides)).toContain(field);
    }
  });

  it("names an issuer by position when it has no valid name, and refuses duplicates", () => {
    expect(refusal(file({ name: "Not A Name" }))).toContain("issuer Not A Name: name");
    expect(refusal("issuers:\n  - 42\n")).toContain("issuer #1");
    const twice = `${file()}${file({ name: "other" }).replace("issuers:\n", "")}`;
    expect(refusal(twice)).toContain("issuer other: issuer");
    const named = `${file()}${file({ issuer: "https://other.test" }).replace("issuers:\n", "")}`;
    expect(refusal(named)).toContain("issuer keycloak: name");
  });

  it("refuses text that is not YAML", () => {
    expect(refusal("issuers: [\n")).toContain("not YAML");
  });
});

describe("createTrustedIssuers", () => {
  const issuers = createTrustedIssuers(parseIdentityFile(file()));
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const shaped = (payload: Record<string, unknown>) =>
    `${b64({ alg: "RS256", kid: "k" })}.${b64(payload)}.c2ln`;

  it("claims a JWT by its unverified iss, and nothing else", () => {
    expect(issuers.claimed(shaped({ iss: BASE.issuer }))?.config.name).toBe("keycloak");
    expect(issuers.claimed(shaped({ iss: "https://elsewhere.test" }))).toBeUndefined();
    expect(issuers.claimed(shaped({}))).toBeUndefined();
    expect(issuers.claimed("0123456789abcdef".repeat(4))).toBeUndefined();
  });

  it("claims nothing over 16 KiB", () => {
    const big = shaped({ iss: BASE.issuer, pad: "x".repeat(MAX_ISSUER_TOKEN_BYTES) });
    expect(issuers.claimed(big)).toBeUndefined();
  });
});
