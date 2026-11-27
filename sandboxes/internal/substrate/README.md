# The Agent Substrate backend

Runs the Tenant's sandboxes as Agent Substrate actors, one per sandbox incarnation (the Sandbox name `sbx-<16>-g<gen>`), each with an ActorTemplate rendered from the same `driver.Spec` the agent-sandbox driver renders a pod from (`template.go:1-4`). It is the `substrate` backend (preview), beside `internal/driver`.

## Interface

- `Driver`, `New`, `Options` (`driver.go:77`, `driver.go:86`, `driver.go:51-72`): the backend, its Substrate client and the timings it runs on.
- `Driver.Put`, `Delete`, `Status`, `Wait`, `Run` (`driver.go:222`, `driver.go:587`, `driver.go:646`, `driver.go:714`, `driver.go:745`): the calls the API makes, and the ping loop that reports when Substrate has answered.
- `API`, `Resolver` (`driver.go:28-43`, `driver.go:46-48`): the part of Substrate's Control service used, and the image resolver.
- `Compute` (`driver.go:669`): an actor and a sandbox's state as the `driver.Status` core reads.
- `WatchWorkers`, `DrainWorker`, `DrainWindow`, `WorkerPoolLabel` (`drain.go:43`, `drain.go:72`, `drain.go:32`, `drain.go:28`): the drain that suspends a stopping worker's actors.
- `Settings`, `RenderTemplate`, `Resolved` (`template.go:56-91`, `template.go:337`, `template.go:250-259`): the Tenant-wide template parts, the template itself, and its images by digest.
- `KeyReference`, `RunsAgent` (`template.go:245`, `template.go:263`): a keyed host's `ate-secret://` reference, and whether a template runs the computer agent.
- `InfoDir`, `TrustDir`, `EngineDir`, `JoinFile`, `CAFile`, `BlockedProbe` (`template.go:26-40`): the paths a template writes inside an actor.
- `Dial`, `ConnOptions` (`conn.go:64`, `conn.go:42-49`): the gRPC connection to Substrate with this service's token.
- `ServerTrust` (`conn.go:104`): the CA Substrate's API service's certificate chains to.
- `Setup`, `SetupAPI` (`setup.go:25`, `setup.go:16-21`): the Tenant's atespace and its editor binding, run once by `sandboxes substrate-setup`.
- `RegistryResolver`, `Resolve` (`resolve.go:16`, `resolve.go:27`): an image reference pinned to its digest.

## Rules

- The service keeps no state of its own: each sandbox's last request lives in the ConfigMap `<name>-state` in the Tenant's namespace (`driver.go:74-76`, `driver.go:145`).
- A spec whose op id the state already holds is a no-op (`driver.go:241-243`).
- Images are resolved to a digest before a template names them; a tag is refused (`driver.go:246-249`, `resolve.go:26-30`).
- An actor keeps the engine or computer agent it was created with; a request to change it is logged and the kept image wins (`driver.go:282-298`).
- Substrate refuses a repoint to a template with different volumes: the request is recorded as refused, the status says `RepointRefused`, and the actor keeps its volumes (`driver.go:394-405`).
- A resume is retried while Substrate is busy or the actor is between states, with a pause doubling from `RetryWait` to 5 s, for `ResumeFor` (5 min) in all (`driver.go:65-72`, `driver.go:418-449`).
- A suspend is one synchronous call, so its snapshot is written before it returns (`driver.go:522-523`).
- A sandbox whose worker stopped reports `Moving` until it runs on another worker (`driver.go:390-392`, `driver.go:698-702`).
- On a worker pod's SIGTERM, the drain suspends that worker's actors, at most 8 at once, for 29 minutes after the deletion (`drain.go:19-35`, `drain.go:30-32`).
- Every template disables golden snapshots: each incarnation is its own (`template.go:228-232`, `template.go:430-434`).

## Side effects

- gRPC calls to Substrate's Control service: atespaces, templates, actors, egress policies (`driver.go:28-43`).
- Creates, updates and deletes the `<name>-state` ConfigMaps in the Tenant's namespace (`driver.go:160-187`).
- Watches every worker pod labelled `ate.dev/worker-pool` (`drain.go:28`, `drain.go:44-46`).
- HEAD requests to image registries, anonymously, cached for an hour (`resolve.go:13-15`, `resolve.go:44`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
