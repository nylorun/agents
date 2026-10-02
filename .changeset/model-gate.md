---
"@nylorun/runtime": minor
---

**Model calls leave the loop through the Model Gate (P1.1).** Every vault-backed model call of the loop goes through one `ModelGate` (`runtime/src/gates/`). `--service gates` serves it over HTTP: one listener (`NYLORUN_GATES_LISTEN_HOST`, `NYLORUN_GATES_LISTEN_PORT`, default port 4100, `NYLORUN_GATES_ALLOWED_HOSTS`) answering `POST /nylorun/v1/model-calls` to callers presenting `NYLORUN_GATES_TOKEN`, with one JSON body once the call has finished. The gate reads the Tenant's host model from its vault and calls the provider with the same adapter, retries, idle watchdog, failure classification and redaction as before.

- **Breaking:** in a container, a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`; it then never reads a model credential. Outside a container (embedding, `startEphemeralRuntime`), a loop without `NYLORUN_GATES_URL` runs the gate in its own process, as before. See `DEPLOYMENT.md`.
- **Breaking:** the `gateway` model kind is removed from `TenantConfig.model` and `StartEphemeralRuntimeOptions.model`. Nothing set it, and it read the Tenant's model credential inside the loop. The exported `gatewayModel` provider is unchanged.
- The gate needs only `NYLORUN_DATABASE_URL` and the Host's Tenant directory (`tenant/`), which it never writes: it runs no migration and opens no Tenant runtime. It refuses a Tenant whose schema is at another version, so the gateway and the runtime must run the same build. gates never shares a process with core or loop: `--service core,gates` is refused.
- The client speaks `node:http` with a 630 s idle timeout, so calls longer than five minutes are not cut off. It never retries; the gate does. A failure of the hop is a failure outcome: an unreachable gate, a connection lost mid-call, a timeout or a 5xx is `transient` and retryable; a refused token is `auth`, naming `NYLORUN_GATES_TOKEN`.
- The `host_stack_config` startup log names the gate (`modelGate`).
