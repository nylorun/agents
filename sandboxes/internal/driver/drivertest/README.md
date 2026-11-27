# A fake cluster for the driver's tests

Fakes the cluster the driver and the API talk to, so their tests need no API server (`fake.go:1`). It is a package of its own because the driver's tests and the API's tests both use it.

## Interface

- `NewFakeClient` (`fake.go:24`): a dynamic client over the objects it is given, for the driver's and the API's tests.

## Rules

- None found: it holds no rule the driver relies on beyond the fake client's own behaviour.

## Side effects

- None found: it keeps its objects in memory.

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
