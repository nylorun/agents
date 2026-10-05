---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
"@nylorun/runtime": minor
"@nylorun/studio": patch
---

**HTTP in flows (manifest-only agents, after M2 and M3).** An `http()` tool is a flow stage, and `http({ url })` is a Loop's HTTP verifier; the Runtime makes both requests through its Tool Gate, with no Action endpoint.

- `@nylorun/core`: an HTTP tool may be a stage in `.pipe()`, a switch case, a Map item or a Loop body; its tool node carries its `http` target and binds nothing. The build refuses an HTTP stage whose input is known to be the wrong type (`flow.input-mismatch`, e.g. after an agent with no `.output()`) and `approval: "always"` on one (`flow.approval-unsupported`). `http()` without a name and an input returns an `HttpTarget`, an HTTP verifier: `.loop(body, { verify: http({ url, method?, credential?, timeoutMs? }), max })`, in the manifest `loop.verify: { http }`. `fn` and `command` verify targets are refused ("Functions are not available yet"). New `flowHttpTarget()` finds an HTTP stage or verifier by stage key; `isHttpTarget()`, `WorkflowHttpVerify` and `WorkflowLoopVerify` are exported.
- `@nylorun/harness`: the flow engine checks an HTTP stage's input against its schema (`tool.invalid-input`), runs it as a `tool` effect and fails the stage on a failed outcome (`http.status`, `http.timeout`, `tool.invalid-output`, …). An HTTP verifier is a `tool` effect with `{ input, output, iteration }` and `context.role: "verify-http"`; a non-verdict or a failed request is `loop.verify-failed`. A Loop body that starts with an HTTP stage is retried with the Loop's input.
- `@nylorun/agents`: `http()` builds HTTP verifiers too.
- `@nylorun/runtime`: a flow's HTTP stages and verifiers are executed like an agent's HTTP tool: address policy, the flow session's vault credential, `Nylorun-Session-Id`/`-Turn-Id`/`-Agent-Id` (the flow agent's id) and the flow effect id as `Idempotency-Key`, run once at the gates service (`POST /nylorun/v1/http-calls` takes `tool: { sessionId?, stage }`) and `uncertain` when the answer is lost. An HTTP verifier's verdict is recorded as `loop.verified`.
- `@nylorun/studio`: the workflow tree shows HTTP stages and HTTP verifiers with their method and URL.
