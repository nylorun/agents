import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage, listFrom } from "../web/src/runtime-body.ts";

test("listFrom returns the named array", () => {
  const providers = [{ id: "anthropic" }];
  assert.equal(listFrom({ providers }, "providers", "missing"), providers);
  assert.deepEqual(listFrom({ vaults: [] }, "vaults", "missing"), []);
});

test("listFrom throws the view's message when the list is missing", () => {
  // `{}` is what an older Runtime answered for /v1/tenant/providers and /models.
  for (const body of [{}, { providers: null }, { providers: {} }, null, "x"])
    assert.throws(
      () => listFrom(body, "providers", "No providers."),
      { message: "No providers." },
    );
});

test("errorMessage reads anything a view threw", () => {
  assert.equal(
    errorMessage(new TypeError("catalog.map is not a function")),
    "catalog.map is not a function",
  );
  assert.equal(errorMessage(new Error("")), "Error");
  assert.equal(errorMessage("boom"), "boom");
  assert.equal(errorMessage({ code: 1 }), '{"code":1}');
  assert.equal(errorMessage(undefined), "undefined");
});
