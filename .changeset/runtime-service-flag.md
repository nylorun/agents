---
"@nylorun/runtime": minor
---

**`--service` names what a Runtime process runs.** The image now starts as `--service core,loop` (the default without a flag): `core` serves the Tenant and Admin APIs and runs the stream relay, and `loop` runs the agent loop and serves the Worker endpoint Restate calls. A container may run several services, which is how the local stack packs them.

- `--role api|worker|all` still works for one release as a deprecated alias of `--service core`, `loop` and `core,loop`, and logs `deprecated_flag` at startup.
- `--service all` is refused: name the services, e.g. `--service core,loop`.
- The `host_stack_config` startup log names `services` instead of `role`.
