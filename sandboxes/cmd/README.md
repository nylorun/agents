# The sandboxes module's binaries

The module's two `main` packages: the service that drives a Tenant's sandboxes, and the computer agent that stands in for the Runtime's engine in a computer. Each ships as its own image, so each is a folder of its own.

## Folders

- [computer](./computer/README.md): the computer agent, an actor's PID 1 in place of the engine's `--service computer`.
- [sandboxes](./sandboxes/README.md): the sandboxes service, its `healthcheck`, `edge-cert`, `substrate-setup` and `provider` subcommands, and the sandbox gateway.
