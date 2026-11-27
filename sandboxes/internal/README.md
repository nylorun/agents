# The sandboxes service's packages

The service's own packages, all `internal/` to the module: the HTTP API, the two backends that run a sandbox, and the pieces the Substrate backend adds around them (the edge, the sandbox gateway, the keys provider and tickets). They are internal because the service's contract with core is the HTTP API alone.

## Folders

- [api](./api/README.md): the service's HTTP API and the `Backend` interface both drivers implement.
- [computer](./computer/README.md): the routes and rules of a computer, shared by the computer agent and the engine.
- [config](./config/README.md): `cluster.json` and the environment, read and validated.
- [driver](./driver/README.md): the agent-sandbox backend: Sandboxes rendered from a spec, status from informers.
- [edge](./edge/README.md): the TLS front actors reach the Harness API and the gates through.
- [gateway](./gateway/README.md): the computers' one way in, through Substrate's router.
- [provider](./provider/README.md): the keys provider Substrate's egress asks for a keyed request's header.
- [substrate](./substrate/README.md): the Agent Substrate backend: one actor per sandbox.
- [ticket](./ticket/README.md): the ticket core signs for a computer and the gateway checks.
