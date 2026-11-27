# The agent-sandbox backend

Implements a sandbox as an `agents.x-k8s.io` Sandbox and a sandbox template, so a sandbox is a pod the cluster's controllers run and the operator can see.

## Interface

- `GVKs` (`sandbox.go:27-32`): the four kinds the backend works with, at `APIVersion` (`sandbox.go:36`).
- `FieldManager` (`sandbox.go:38`): `nylorun-sandboxes`, the manager every write goes through.
- `Spec` (`sandbox.go:77-131`): the body a sandbox is created with.
- `SpecKeys`, `KeyHost` (`sandbox.go:112-125`): the settings a sandbox's environment carries.
- `SpecNetwork` (`sandbox.go:171-175`): the egress a sandbox's pod is given.
- `Error` (`sandbox.go:181`): why a sandbox can't be created, in the API's own error shape.
- `ValidateName` (`sandbox.go:194`), `Normalize` (`sandbox.go:202`): a sandbox's name.
- `Render` (`sandbox.go:341`): a sandbox spec as YAML.
- `New` (`sandbox.go:494`), `WithMirrors` (`sandbox.go:500`): the backend and the image mirrors it rewrites references with.
- `Put` (`sandbox.go:534`), `Delete` (`sandbox.go:578`), `Status` (`sandbox.go:610`), `Wait` (`sandbox.go:619`): the operations the API calls.
- `Cache` (`status.go:58`), `NewCache` (`status.go:75`), `Start` (`status.go:101`): the polled status the API reads.
- `Status` (`status.go:17-46`), `Waits` (`status.go:49-50`): a sandbox's state and how long a wait may last.
- `Mirrors` (`mirror.go:15`), `NewMirrors` (`mirror.go:21`): image references rewritten to the mirrors `enable` found.

## Rules

- A sandbox is created, updated and deleted through `FieldManager` and the Tenant's credentials; no status is written by hand (`sandbox.go:38`).
- The last op id lives on the Sandbox itself, so a restart loses nothing (`sandbox.go:3-4`).
- A wait ends at `Waits`, and the status cache answers from its last poll (`status.go:49-50`).
- An image reference is rewritten to a mirror only when `<name>` has been mirrored, and pinned by digest before it is written (`mirror.go:1-4`).

## Side effects

- The Kubernetes API server: Sandboxes, sandbox templates, egresses and claims, in the Tenant's namespace (`sandbox.go:28-31`).
- The image registries, over HTTPS, to resolve a reference to a digest (`mirror.go`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
