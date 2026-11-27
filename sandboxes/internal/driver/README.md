# The agent-sandbox backend

Drives agent-sandbox Sandboxes (`agents.x-k8s.io/v1beta1`, controller v1.0.10) in one namespace with the dynamic client: it renders the pod shape from a spec, applies it server-side, and reads status from namespace informers. It keeps no state of its own: the operation id of the last apply is an annotation on the Sandbox, and the claim, pods and join Secret carry the rest.

## Interface

- `Driver` (`sandbox.go`): `Put`, `Delete`, `Status`, `Wait`, `Ping`, `Synced`, `Namespace`, `Cache`, `WithMirrors`; built by `New(client, namespace, urls)`.
- `Spec` (`sandbox.go`): the PUT body: `opId`, `mode`, `image`, `entrypoint`, `harnessImage`, `command`, `cpus`, `memoryMiB`, `storageGiB`, `stopGraceSeconds`, `shutdownTime`, `shutdownPolicy`, `env`, `joinToken`, `network`, `keys`.
- `SpecKeys`, `KeyHost`, `MaxKeyHosts` (`sandbox.go`): the keyed hosts, at most 200.
- `Name(tenant, id, volumeGen)`, `NamePattern`, `ValidateName` (`sandbox.go`): `sbx-<lowercase base32(sha256("<tenant>/<id>"))[:16]>-g<volumeGen>`.
- `Render(namespace, name, spec, urls)` (`sandbox.go`): the Sandbox object, golden-tested in `testdata/sandbox.golden.json`.
- `Status` (`status.go`): `name`, `exists`, `deleting`, `mode`, `ready`, `suspended`, `expired`, `podUID`, `podPhase`, `imageID`, `volume`, `opId`, `shutdownTime`, `reason`, `message`, `drainedAt`.
- `Waits` (`status.go`): the states `?wait=` accepts, `ready`, `suspended`, `expired` and `gone`.
- `Cache`, `NewCache`, `Compute` (`status.go`): the Sandbox, Pod and claim informers, and the status derived from them.
- `Mirrors`, `NewMirrors` (`mirror.go`): image repository to mirror, `To` and `From`.
- Constants (`sandbox.go`): `APIVersion`, `FieldManager` (`nylorun-sandboxes`), `OpAnnotation` (`nylorun.dev/op`), `RoleLabel`, `SandboxLabel`, `ManagedLabel`, `DefaultImage` (`python:3.13-slim`), `JoinDir`, `JoinFile`, `VolumeName` (`data`).
- [drivertest](./drivertest/README.md): the fake dynamic client the tests and the service suite drive it with.

## Rules

- A spec whose `opId` the Sandbox already records is a no-op: `Put` returns the current status (`sandbox.go`, `Put`).
- `ValidateName` accepts only `NamePattern`, and `Spec.Normalize` refuses `entrypoint: builtin` and the reserved environment names (`HOME`, `NYLORUN_POD_UID`, `NYLORUN_SANDBOX_JOIN_FILE`, `NYLORUN_HARNESS_URL`, `NYLORUN_GATES_URL`, `NYLORUN_EGRESS_PROXY`, `NYLORUN_SANDBOX_KIND`) (`sandbox.go`).
- Every apply is server-side with `FieldManager` `nylorun-sandboxes`, so another writer's fields stay (`sandbox.go`, `Put`).
- The join token is written to Secret `<name>-join`, key `token`, before the Sandbox is applied; the same value is not rewritten (`secret.go`, `putJoinSecret`).
- The Secret's role grants get, create, update, patch and delete, and no list or watch (`sandbox.go`, `Render`).
- The pod runs as uid 1000, mounts the claim at the workspace, and reads the join token at `JoinDir`/`JoinFile` (`sandbox.go`).
- `?wait=` is limited to `Waits`, and an unknown value is `400 invalid_request`; the wait wakes on informer events, not a poll (`status.go`, `Cache.Wait`).
- Status is read only from the informers, so nothing is fetched per request except the apply (`status.go`).

## Side effects

- Applies, deletes and reads Sandboxes, Pods, claims and Secrets in the configured namespace through the dynamic client (`sandbox.go`, `status.go`, `secret.go`).
- Runs three informers (Sandboxes, Pods labelled `nylorun.dev/role=sandbox`, claims) for the namespace (`status.go`, `NewCache`).
- Writes the join Secret, and deletes it with the sandbox (`secret.go`).
- Writes one log line per apply and per wait (`sandbox.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`); `go test ./internal/driver -update` rewrites the golden file.
