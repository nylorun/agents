# The sandboxes service's packages

What the `sandboxes` command is built from: the HTTP API core calls, the two backends that drive a cluster, and the side services the Substrate backend needs beside it.

## Folders

- [api](./api/README.md): the HTTP routes core calls, and the `Backend` they use.
- [computer](./computer/README.md): the computer agent that serves an actor that is a computer.
- [config](./config/README.md): `cluster.json`, the token file and the service's environment.
- [driver](./driver/README.md): the agent-sandbox backend, its status and its image mirrors.
- [driver/drivertest](./driver/drivertest/README.md): a fake cluster for the driver's and API's tests.
- [edge](./edge/README.md): the TLS front Substrate actors reach the Runtime through.
- [gateway](./gateway/README.md): the sandbox gateway into Substrate's router.
- [provider](./provider/README.md): the keys provider Substrate's egress asks for a keyed request.
- [substrate](./substrate/README.md): the Agent Substrate backend.
- [ticket](./ticket/README.md): the computer tickets core signs and the gateway and computer check.
