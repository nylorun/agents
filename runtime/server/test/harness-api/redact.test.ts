/**
 * The Runtime's own tokens never reach the record from what a harness reports (R4, HC14).
 */
import { describe, expect, it } from "vitest";
import { REDACTED_TOKEN, redactTokens } from "../../src/harness-api/redact.js";

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (typ: string) =>
  `${part({ alg: "ES256", typ, kid: "k1" })}.${part({ sub: "s1", exp: 1, iat: 0 })}.${"s".repeat(64)}`;

describe("redactTokens", () => {
  it("replaces a Nylorun token wherever a string holds it, and keeps the shape", () => {
    const egress = jwt("nylorun-egress+jwt");
    const value = {
      kind: "completed",
      output: { stdout: `HTTPS_PROXY=http://nylorun:${egress}@egress:3128\nHOME=/harness/home`, exitCode: 0 },
      lines: [`run ${jwt("nylorun-run+jwt")}`],
    };
    expect(redactTokens(value)).toEqual({
      kind: "completed",
      output: { stdout: `HTTPS_PROXY=http://nylorun:${REDACTED_TOKEN}@egress:3128\nHOME=/harness/home`, exitCode: 0 },
      lines: [`run ${REDACTED_TOKEN}`],
    });
  });

  it("leaves other tokens and values untouched, and returns the same value when there is nothing", () => {
    const other = jwt("JWT");
    expect(redactTokens(`id token ${other}`)).toBe(`id token ${other}`);
    const value = { a: [1, "two", { three: null }] };
    expect(redactTokens(value)).toBe(value);
  });
});
