# The driver's fake cluster

A dynamic-client fake for the four resources the driver touches, so tests drive a whole apply-and-read cycle with no cluster. It is a package of its own so the driver's tests and the API's can share it.

## Interface

- `NewFakeClient(objects ...runtime.Object) *fake.FakeDynamicClient` (`fake.go`): a dynamic fake with a list kind registered for Sandboxes, Pods, claims and Secrets, and a reactor for server-side apply on Sandboxes.

## Rules

- A server-side apply is emulated as create-or-replace: a new object gets a UID `uid-<n>` and generation 1; an existing one keeps its UID, keeps its generation when `spec` is unchanged and bumps it by one when it changed, and keeps its `status` (`fake.go`).
- Only `types.ApplyPatchType` patches on `sandboxes` are handled; any other patch falls through to the fake's own tracker (`fake.go`).

## Side effects

- Writes only to the fake client's tracker, in memory; nothing reaches a cluster or a file (`fake.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
