---
"@nylorun/harness": major
---

**The harness has no provider adapters.** The harness makes no model call: it builds the provider-neutral `ModelCall` and reads back a `ModelCandidate`, and the Runtime's Model Gate makes the provider call. MIGRATION.md ("The harness has no provider adapters") has the details.

- **Breaking (`@nylorun/harness`): the `./model/adapters` subpath is removed**, with the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages translators in it (`toChatCompletions`, `fromChatCompletions`, `chatCompletionsAdapter`, `toResponses`, `fromResponses`, `responsesAdapter`, `toMessages`, `fromMessages`, `anthropicAdapter`, their request and message types, `AnthropicAdapterOptions`, `AdapterSend`) and `preparedModel`. The package root no longer exports `PreparedModelOptions`. A host that runs the engine in process passes its own `onModelCall` (the Runtime's `piModel`, or its own provider mapping) and reports the provider request with `context.reportPreparedCall({ adapter, call })`, as `preparedModel()` did. Nothing changes on the wire, in manifests or in checkpoints.
