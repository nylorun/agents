---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/cli": minor
"@nylorun/studio": minor
---

**Long sessions on any model: compaction.** A session whose history outgrows the model's context window keeps going, on a 16k local model as on a 1M hosted one.

- **Compaction.**
  - **When.** Before each model call the engine estimates the prompt: the last reported usage, plus about four characters per token for what came after. If the estimate would not leave room for the reply, the engine first compacts: it asks the model to summarize the older history, then keeps about the newest 20,000 tokens (at most 30% of the window) verbatim.
  - **What it keeps.** The cut never separates a tool call from its result. The current turn's request is always kept. A later compaction merges with the earlier summary.
  - **Overflow.** If a provider still reports a context overflow, the engine compacts once and asks again.
  - **Storage.** The summary is a `compaction` transcript entry that replaces the older entries in the session state; the event log keeps the full history. The summary call is a journaled model effect, so replays are deterministic.
  - **New event.** `context.compacted` (`trigger`, `tokensBefore`, `tokensAfter`).
- **Custom endpoints.**
  - **Settings.** Model Settings take `settings: { contextWindow, maxTokens, reasoning, compat }` for a custom OpenAI-compatible provider (vLLM, SGLang, llama.cpp, Ollama, LM Studio). `compat` is passed to pi-ai: `thinkingFormat`, `thinkingTokenBudgetField`, `chatTemplateKwargs` and the rest.
  - **Defaults.** Without settings, a custom endpoint is assumed to have a 32k window and an 8k output limit. They used to be 128k and 16k.
  - **Where to set them.** `nylo configure` asks for the window and output limit. Studio's Model Settings shows all four fields.
- **Storage.**
  - Model effects no longer journal the model request next to the call, so each call's prompt is stored once.
  - When a turn ends, its model effects are slimmed to their identity and status; the transcript holds the answers.
  - Session storage now grows with the window, not with the square of the session's length.
- **Core.**
  - `TranscriptEntry` adds `compaction` (`TranscriptCompactionEntry`).
  - `ModelAdapterContext.compaction` marks a summary call.
  - `CustomModelSettings` / `CustomModelSettingsSchema` describe the custom endpoint settings.
