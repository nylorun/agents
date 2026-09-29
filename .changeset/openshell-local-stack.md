---
"nylorun": minor
"@nylorun/cli": patch
---

**OpenShell on the local stack.** `nylorun start --sandbox openshell` adds NVIDIA's OpenShell 0.1.2 gateway (`openshell-gateway`) beside the stack and points the Runtime at it, so sessions' sandboxes run as containers with their network policy enforced outside them. The choice is kept in the stack's `.env`, and `--sandbox virtual` stops the gateway again.

- **Containers.** Six containers run at rest, plus two for each live sandbox. They are a host-networked supervisor, and a workload with no network of its own. The gateway mounts the Docker socket and publishes gRPC and health on loopback (`18080`, `18081`, or free ports).
- **Telemetry.** The gateway sends anonymous usage counts to NVIDIA. `nylorun start` says so each time it starts the gateway, and `--openshell-telemetry off` turns them off.
- **Reset.** `nylorun reset` also deletes the stack's sandbox containers and volumes, labelled `openshell.ai/sandbox-namespace=<project>`, and the gateway's state.
- **Doctor.** `nylo doctor sandbox` shows the Tenant's default sandbox, and explains the OpenShell backend when it is selected.
- **Smoke.** `npm run test:stack:openshell` runs a session's `bash` in an OpenShell sandbox on a temporary stack.
