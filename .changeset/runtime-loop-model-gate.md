---
"@nylorun/runtime": minor
---

**The loop can call models through the gates service.** A process that runs loop with `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN` sends every vault-backed model call to the gate and never reads a model credential itself. Without `NYLORUN_GATES_URL` it calls the model in its own process, as before. The `host_stack_config` startup log names the gate (`modelGate`).

- The client speaks `node:http` with a 630 s idle timeout, so calls longer than five minutes are not cut off. It never retries; the gate does.
- A failure of the hop is a failure outcome, not an uncertain effect: an unreachable gate, a connection lost mid-call (the provider may have billed it), a timeout or a 5xx is `transient` and retryable; a refused token is `auth`, naming `NYLORUN_GATES_TOKEN`.
- Reading the host model credential moved from `VaultService` to `HostModelVault` (`vault/host-model.ts`), which only the gate may import (`scripts/check-boundaries.mjs`).
