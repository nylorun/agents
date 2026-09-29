/**
 * The sandbox conformance suite against a real OpenShell gateway (Sandboxes v3, P3). Skipped
 * unless NYLORUN_TEST_OPENSHELL=1; the gateway is NYLORUN_TEST_OPENSHELL_GATEWAY (default
 * http://127.0.0.1:8080). Sandboxes use the gateway's default image.
 */
import { describe, it } from "vitest";
import { openshellBackend } from "../../src/adapters/sandbox/openshell/backend.js";
import { conformance } from "./conformance.js";

const gateway = process.env.NYLORUN_TEST_OPENSHELL_GATEWAY ?? "http://127.0.0.1:8080";

if (process.env.NYLORUN_TEST_OPENSHELL === "1")
  conformance("openshell", {
    backend: () => openshellBackend({ gateway }),
    // The default image has no curl: a TCP connect through the supervisor fails when blocked.
    fetch: (url) => {
      const { hostname, port, protocol } = new URL(url);
      const target = port || (protocol === "https:" ? "443" : "80");
      return `bash -c 'exec 3<>/dev/tcp/${hostname}/${target}' && echo 200`;
    },
    network: false,
    image: null,
  });
else
  describe.skip("openshell sandbox conformance (set NYLORUN_TEST_OPENSHELL=1)", () => {
    it("needs a gateway", () => {});
  });
