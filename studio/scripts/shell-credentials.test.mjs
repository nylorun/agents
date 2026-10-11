import assert from "node:assert/strict";
import test from "node:test";
import {
  headerPreview,
  injectOf,
  parseAllowedHosts,
  shellSecretRequest,
} from "../web/src/shell-credentials.ts";

const form = { name: "GH_TOKEN", hosts: "api.github.com, GitHub.com", value: "ghp_x", header: "", format: "" };

test("a secret lists its hosts once, lowercased, and leaves the default header out", () => {
  assert.deepEqual(shellSecretRequest("environment_secret", { ...form, hosts: "api.github.com\ngithub.com GitHub.com" }), {
    name: "GH_TOKEN",
    secret: {
      type: "environment_secret",
      value: "ghp_x",
      allowedHosts: ["api.github.com", "github.com"],
    },
  });
});

test("a secret keeps a custom header and format", () => {
  const { secret } = shellSecretRequest("environment_secret", {
    ...form,
    header: "Authorization",
    format: "Basic {base64:x-access-token:{value}}",
  });
  assert.deepEqual(secret.inject, { header: "Authorization", format: "Basic {base64:x-access-token:{value}}" });
  assert.deepEqual(injectOf("PRIVATE-TOKEN", "{value}"), { header: "PRIVATE-TOKEN", format: "{value}" });
});

test("a variable keeps its value as typed", () => {
  assert.deepEqual(shellSecretRequest("environment_variable", { ...form, name: " REGION ", value: "eu-west-1" }), {
    name: "REGION",
    secret: { type: "environment_variable", value: "eu-west-1" },
  });
});

test("refuses hosts the Runtime would refuse, naming the entry", () => {
  for (const hosts of ["https://api.github.com", "*.github.com", "1.2.3.4", "api.github.com:443", "localhost", ""])
    assert.throws(() => parseAllowedHosts(hosts), hosts || "empty");
  assert.throws(() => parseAllowedHosts("ok.example.com, *.bad.com"), /“\*\.bad\.com”/);
});

test("refuses a format without exactly one {value}, and a bad header name", () => {
  assert.throws(() => injectOf("Authorization", "Bearer"), /exactly once/);
  assert.throws(() => injectOf("Authorization", "{value} {value}"), /exactly once/);
  assert.throws(() => injectOf("x api key", "{value}"), /not a header name/);
});

test("a PUT replaces the secret: rotation sends its hosts again, and needs a name and a value", () => {
  assert.deepEqual(shellSecretRequest("environment_secret", { ...form, value: "new" }).secret, {
    type: "environment_secret",
    value: "new",
    allowedHosts: ["api.github.com", "github.com"],
  });
  assert.throws(() => shellSecretRequest("environment_secret", { ...form, value: "" }), /Enter a value/);
  assert.throws(() => shellSecretRequest("environment_variable", { ...form, name: " " }), /Name the variable/);
});

test("previews the header with the value masked", () => {
  assert.equal(headerPreview("", ""), "Authorization: Bearer <secret>");
  assert.equal(
    headerPreview("Authorization", "Basic {base64:x-access-token:{value}}"),
    "Authorization: Basic base64(x-access-token:<secret>)",
  );
});
