# The Agent Substrate backend

Runs each sandbox as an Agent Substrate actor (`ateapi.v1`), for a Host without Kubernetes Sandboxes: it renders an actor template from the spec, creates or repoints the actor and its egress policy, and keeps each sandbox's last request in a ConfigMap of the Tenant's namespace. It is the second `Backend` behind the same `/v1/pods` API, and the one `nylorun local sandbox enable` uses on a Host that runs Substrate.

## Interface

- `API` (`driver.go`): the part of Substrate's Control service the driver uses: atespace, actor templates, actors, egress policies.
- `Resolver` (`driver.go`): `Resolve` pins an image reference to its digest.
- `Options`, `New(api, o)` (`driver.go`): `Settings`, `Namespace`, `Kube`, `Resolver`, `Log`, `Now`, `PollInterval` (250 ms), `CallTimeout` (2 min), `ResumeFor` (5 min), `RetryWait` (250 ms, doubled to 5 s).
- `Driver` (`driver.go`): `Put`, `Delete`, `Status`, `Wait`, `Ping`, `Synced`, `Run(ctx, interval)`, `WatchWorkers`, `DrainWorker`.
- `Compute(name, actor, state)` (`driver.go`): the status from an actor and the kept state.
- `Moving`, `RepointRefused` (`driver.go`): the `message` a status carries while a change is in flight, and the reason a repoint was refused.
- `RegistryResolver` (`resolve.go`): pins a ref to `name@sha256:…` with an anonymous remote HEAD, cached for 1 h.
- `Setup(ctx, api, atespace, principal)` (`setup.go`): the atespace and its access policy.
- `ConnOptions`, `Dial(ctx, o)`, `ServerTrust(ctx, kube)` (`conn.go`): the gRPC connection to `ate-api-server`, and the service-DNS trust bundle.
- `Settings`, `Network`, `Resolved`, `RenderTemplate`, `TemplateName`, `ToProto`, `EgressPolicy`, `KeyReference`, `EngineReference`, `RepointRefusal`, `RunsAgent` (`template.go`): the actor template's shape and rules.
- Constants (`template.go`): `InfoDir` (`/run/nylorun/actor`), `TrustDir` (`/run/nylorun/trust`), `EngineDir` (`/nylo`), `JoinFile` (`/tmp/.nylorun-join`), `CAFile` (`/tmp/.nylorun-ca.pem`), `BlockedProbe` (`169.254.169.254:80`), `EngineVolume` (`nylo`), `AgentFile` (`/computer`), `DefaultKeysProvider` (`keys.nylorun.dev`), `AgentGo`, `AgentEngine`.
- `ReconnectTuning` (`template.go`): the engine's reconnect without its 5 s wait after a restore, merged under the operator's own tuning.
- Constants of the drain (`drain.go`): `WorkerPoolLabel` (`ate.dev/worker-pool`), `DrainWindow` (29 min).
- Dial constants (`conn.go`): `servicedns.podcert.ate.dev/identity`, `podcert.ate.dev/canarying=live`, port 443, 1 h tokens.

## Rules

- A `Put` that repeats the opId the state records, on an actor that exists, is a no-op and answers the current status (`Put`).
- An actor in `DELETING` is `409 deleting`; an image that does not resolve to a digest is `422 invalid_spec`, since Substrate runs images by digest (`Put`).
- A new sandbox needs a `joinToken` unless it is a computer (`Put`).
- An actor keeps the engine it was created with: Substrate repoints only to a template with identical volumes, and the engine is a pinned image volume, so a newer engine waits for a new incarnation; moving between the engine and the computer agent changes the volume, so it is refused (`RepointRefused`) and the computer gets a new volume from its latest disk version (`Put`, `RepointRefusal`).
- The state ConfigMap is `<name>-state` in the Tenant's namespace, because Substrate's actors carry no labels or annotations (`driver.go`, `stateSuffix`).
- One call is bounded by `CallTimeout` (2 min, since a suspend writes a snapshot); bringing an actor to `Running` may use `ResumeFor` (5 min) in one call, because cancelling it would cancel the image pull or restore in flight (`Options`).
- Retries wait `RetryWait`, doubling to 5 s, and a change ends as `Moving` while it is in flight (`drive`, `Moving`).
- An atespace `Setup` already made is left alone; it makes the principal an editor of the `default` access policy (`setup.go`).
- A worker that turns `Terminating` drains its actors over `DrainWindow` (29 min), 8 at a time: each is suspended, not deleted (`drain.go`).
- A registry reference is resolved to a digest and cached 1 h; `index.docker.io/` is read as `docker.io/` (`resolve.go`).
- The connection is TLS 1.3 to `<apiService>.<systemNamespace>.svc:443`, with a token whose audience is that name, and a port-forward when no endpoint is set (`conn.go`, `Dial`).
- A keyed host becomes an `ate-secret://<provider>/<base64url sandbox>/<host>` reference, so the actor never holds the key (`template.go`, `KeyReference`).
- A computer's engine runs `--service computer` on its port, with no join token, edge or loop (`template.go`, `renderComputer`).

## Side effects

- Calls Substrate's Control service: atespace, templates, actors, egress policies (`driver.go`).
- Reads and writes the ConfigMap `<name>-state`, and deletes it with the sandbox (`driver.go`).
- Opens a port-forward to `ate-api-server` when no endpoint is set (`conn.go`).
- Sends anonymous HEAD requests to a registry to resolve a digest (`resolve.go`).
- Watches worker pods and calls `SuspendActor` on the actors a draining worker runs (`drain.go`).
- Logs the kept-image and drain decisions (`driver.go`, `drain.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
