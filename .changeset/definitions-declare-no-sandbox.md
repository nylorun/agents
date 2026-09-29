---
"@nylorun/core": major
"@nylorun/runtime": minor
"@nylorun/agents": major
---

**Definitions no longer declare a sandbox.** `.sandbox()` on ReAct and flow agents, and the `sandbox`, `SandboxError`, `SandboxOptions` and `SandboxCapability` exports, are removed. Open the session with one instead, `createSession({ sandbox: { … } })`, or set the Tenant's default; see `MIGRATION.md`.

- **Build and registration.** A capability that still carries `sandbox` fails the build (`sandbox.in-definition`), and `PUT /v1/agents/:id` refuses such a definition with a `400` that names it. Definitions stored before this release keep their sandbox.
- **Trees.** `sandbox.mismatch` and `workflow.sandbox-mismatch` are gone, with the workflow manifest's derived `sandbox`: a tree shares the sandbox its session was opened with.
- **Executors.** The action claim reports whether the session has a sandbox (`ActionClaim.sandbox`), and `ctx.sandbox` follows it.
