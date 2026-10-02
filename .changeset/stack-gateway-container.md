---
"@nylorun/runtime": minor
"nylorun": minor
---

**The local stack runs a gateway container: model calls leave the Runtime.** `nylorun up` now runs the Runtime image twice, the combined packing: `runtime` (`--service core,loop`: the APIs and the agent loop) and `gateway` (`--service gates`: the Model Gate). Every model call of the loop crosses the gateway, which alone reads the Tenant's model credential and calls the provider. A new stack starts with the gateway.

- **Breaking for hand-written Compose files:** in a container, a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`. Run the image a second time with `--service gates` (see `DEPLOYMENT.md`). The image's default command is now `--service core,loop`.
- The gateway has no published port, mounts only the Host's Tenant directory (`tenant/`) read-only, and reaches model servers on this machine at `host.docker.internal`. `stack/.env` holds `NYLORUN_GATES_TOKEN`, generated once and kept across starts.
- `nylorun status` shows a Gateway line, `nylorun doctor` fails when the gateway is unhealthy and names `nylorun logs gateway`, and `nylorun logs gateway` is accepted.
- An image set with `NYLORUN_RUNTIME_IMAGE` must be this release or newer: older Runtimes don't know `--service`.
