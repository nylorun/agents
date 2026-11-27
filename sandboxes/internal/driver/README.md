# The agent-sandbox driver

Drives agent-sandbox Sandboxes (`agents.x-k8s.io/v1beta1`) in one namespace with the dynamic client: it renders the pod shape, applies it server-side, and reads status from namespace informers (`sandbox.go:1-4`). It is the default backend; `internal/substrate` is the other one.

## Interface

- `Spec` (`sandbox.go:77-131`): one sandbox's request — op id, mode, image, entrypoint, harness image, command, resources, env, join token, network and keys.
- `SpecKeys`, `KeyHost` (`sandbox.go:112-125`), `SpecNetwork` (`sandbox.go:171-175`): the keyed hosts and the network a sandbox may reach.
- `Name` (`sandbox.go:71`): the Sandbox name for a tenant, id and volume generation.
- `ValidateName`, `Spec.Normalize` (`sandbox.go:194`, `sandbox.go:202`): the name and spec checks every request passes first.
- `Render` (`sandbox.go:341`): the Sandbox object for a spec, which the controller turns into a pod.
- `Driver`, `New`, `WithMirrors` (`sandbox.go:494-500`): the driver and its client, namespace and URLs.
- `Driver.Put`, `Delete`, `Status`, `Wait` (`sandbox.go:534`, `sandbox.go:578`, `sandbox.go:610`, `sandbox.go:619`): the four calls the API makes.
- `Status` (`status.go:17-46`), `Waits` (`status.go:49-50`): the status core reads, and the states `?wait=` may name.
- `Cache` (`status.go:58`), `NewCache` (`status.go:75`): the informers the status is read from.
- `Mirrors` (`mirror.go:15`), `NewMirrors` (`mirror.go:21`): the cluster's image mirrors, by repository.
- `Error` (`sandbox.go:181`): a status, code and message the API answers with.

## Rules

- The Sandbox's kind is `agents.x-k8s.io/v1beta1` (`APIVersion`, `sandbox.go:36`), and every object is applied with field manager `nylorun-sandboxes` (`sandbox.go:38`).
- The driver keeps no state of its own: the op id of the last apply is the `nylorun.dev/op` annotation on the Sandbox (`sandbox.go:3-4`, `sandbox.go:40`).
- Every object it makes carries `nylorun.dev/role`, `nylorun.dev/sandbox` and `app.kubernetes.io/managed-by` (`sandbox.go:41-43`).
- The join Secret is `<name>-join`, with key `token`, mounted at `/run/nylorun/join`; the Secret is read, created, updated and deleted, never listed or watched (`secret.go:13-14`).
- A wait is one of `ready`, `suspended`, `expired` or `gone`; any other is `400 invalid_request` (`sandbox.go:623-627`).
- A mirrored repository keeps its tag or digest: only the repository is replaced (`mirror.go:11-14`).

## Side effects

- Creates, updates and deletes Sandboxes in the Tenant's namespace (`sandbox.go:534`, `sandbox.go:578`).
- Creates and deletes the join Secret (`secret.go:22`, `secret.go:51`).
- Watches Sandboxes, pods and claims in the namespace through informers (`status.go:69-101`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
