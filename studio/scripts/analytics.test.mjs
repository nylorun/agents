import assert from "node:assert/strict";
import test from "node:test";
import { analyticsId, pagePath } from "../web/src/analytics.ts";

test("a page view carries the route's shape: ids become :id", () => {
  assert.equal(pagePath("/tenants/t_9f2/agents/support-bot/sessions/0b7e-4c"), "/tenants/:id/agents/:id/sessions/:id");
  assert.equal(pagePath("/tenants/t_9f2/sessions/s1/"), "/tenants/:id/sessions/:id");
  assert.equal(pagePath("/tenants/t_9f2/vault"), "/tenants/:id/vault");
  assert.equal(pagePath("/tenants/t_9f2/settings"), "/tenants/:id/settings");
  assert.equal(pagePath("/tenants/t_9f2/agents/sessions"), "/tenants/:id/agents/sessions");
  assert.equal(pagePath("/"), "/");
});

test("the measurement id comes from index.html, and only a well-formed one", () => {
  const doc = (content) => ({
    querySelector: (selector) =>
      selector === 'meta[name="nylorun-analytics"]' && content !== undefined ? { content } : null,
  });
  assert.equal(analyticsId(doc("G-K6RPDFH6Q6")), "G-K6RPDFH6Q6");
  assert.equal(analyticsId(doc(undefined)), undefined);
  assert.equal(analyticsId(doc("")), undefined);
  assert.equal(analyticsId(doc("UA-1234-1")), undefined);
});
