import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentPath,
  environmentRoute,
  legacyEnvironmentRedirect,
} from "../web/src/environment-path.ts";

test("an Environment's page is one percent-encoded segment, opened on a tab", () => {
  assert.equal(environmentPath("team/build"), "/environments/team%2Fbuild");
  assert.equal(environmentPath("team/build", "overview"), "/environments/team%2Fbuild");
  assert.equal(environmentPath("team/build", "disk"), "/environments/team%2Fbuild?tab=disk");
});

test("a route names the list, one Environment, or a segment that is not found", () => {
  assert.deepEqual(environmentRoute("/environments"), { kind: "list" });
  assert.deepEqual(environmentRoute("/environments/"), { kind: "list" });
  assert.deepEqual(environmentRoute("/environments/team%2Fbuild"), { kind: "environment", id: "team/build" });
  assert.deepEqual(environmentRoute("/environments/%E0"), { kind: "invalid", segment: "%E0" });
  assert.equal(environmentRoute("/environments/a/b"), undefined);
  assert.equal(environmentRoute("/sessions"), undefined);
});

test("old Environment, Credentials, vault and sandbox links open the Environment's page", () => {
  assert.equal(
    legacyEnvironmentRedirect("/environments", "?selected=team%2Fbuild&tab=secrets"),
    "/environments/team%2Fbuild?tab=secrets",
  );
  assert.equal(
    legacyEnvironmentRedirect("/environments", "?selected=team%2Fbuild&tab=details&label=a%3Db"),
    "/environments/team%2Fbuild?label=a%3Db",
  );
  assert.equal(legacyEnvironmentRedirect("/environments", "?label=a%3Db"), undefined);
  assert.equal(
    legacyEnvironmentRedirect("/settings/credentials", "?environment=team%2Fbuild"),
    "/environments/team%2Fbuild?tab=secrets",
  );
  assert.equal(
    legacyEnvironmentRedirect("/vault", "?environment=team%2Fbuild&embed=1"),
    "/environments/team%2Fbuild?tab=secrets&embed=1",
  );
  assert.equal(legacyEnvironmentRedirect("/settings/credentials", ""), "/environments");
  assert.equal(legacyEnvironmentRedirect("/sandboxes", "?label=a%3Db"), "/environments?label=a%3Db");
  assert.equal(legacyEnvironmentRedirect("/sessions", ""), undefined);
});
