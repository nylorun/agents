---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

**Real sandboxes on OpenShell.** Set `NYLORUN_OPENSHELL_GATEWAY` (for example `http://127.0.0.1:8080`) and the Runtime adds an `openshell` backend: sandboxes provisioned by an NVIDIA OpenShell 0.1.2 gateway, on its Docker driver today. The gateway's supervisor enforces each sandbox's network policy outside the sandbox, so root inside it cannot bypass it. `auto` prefers OpenShell when its gateway is healthy; `sandbox.backend` accepts `openshell`.

- **Images.** A session's inline sandbox may now name an `image` on an OpenShell Tenant. The image needs `grep`, `find`, `head`, `cat` and `mkdir`, which the tools use; opening a sandbox without them fails with a message naming them. Without an image, the gateway's default is used.
- **Workspace.** OpenShell's workspace is `/sandbox`. The tools resolve relative paths there, `/workspace/…` in a tool path still names it, and the tool text a session is pinned with says `/sandbox`.
- **Network.** `network.allow` becomes one OpenShell rule on ports 80 and 443, wildcards included; no hosts means no egress. `open` egress is refused on this backend.
- **Lifecycle.** Idle stop and resume use OpenShell's stop and start, so files survive. A sandbox removed outside the Runtime is created again, and `sandbox.state` says its files were lost.
- **Tests.** `npm run test:openshell:up -w @nylorun/runtime` starts a test gateway; with `NYLORUN_TEST_OPENSHELL=1` the conformance suite runs against it. The client is generated from OpenShell's protobufs (`scripts/openshell-client.mjs`) and vendored.
