---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
---

**Bring your own harness: harness ids, harness-owned state, and who wrote each event (R4.1, R4.2, R4.4, R4.9).**

- **Harness ids and routing.** An Environment's `harness` takes any harness id (`^[a-z][a-z0-9-]{1,62}$`). It is no longer only `nylorun`.
  - **The pin.** A session pins its harness when it opens: its Environment's harness, else `nylorun`. A flow always runs `nylorun`. `GET /v1/sessions/{id}` returns the pin as `harness`.
  - **Routing.** Only a connection whose `hello.name` is that id takes the session's runs.
  - **Our harness's name.** It now says `nylorun` in `hello`. A harness that says `@nylorun/harness` is refused with a message naming the new id, so an older harness image needs this Runtime's.
  - **Placement.** It is keyed by the real harness id, and `"*": {hosts: []}` refuses any harness the map does not name.
  - **Drift.** A turn on an Environment that now runs another harness is `409 harness_mismatch`; open a new session. For a pod Environment, a changed `harness` applies at the pod's next wake, like its image.
- **Per-harness tokens.** `nylorun-operate harness token put <id>` makes a custom harness container's own Harness API credential, bound to its id; `list` and `rm` manage them. `NYLORUN_HARNESS_TOKEN` stays ours, bound to `nylorun`.
- **A custom harness as a pod's image.** A pod Environment whose harness is not ours runs its `image` as the harness: the image's own entrypoint (`entrypoint: "image"` to the sandboxes service), with nothing copied in. It needs `image`.
- **Harness-owned state.** Core stores a harness's turn state as sent and never reads it. Our engine now aligns its state with the turn's manifest itself.
  - **Limits for a custom harness.** Its state is at most 256 KiB, or its turn fails. It cannot pause for approvals in Harness API 2.
  - **Native tools.** It may declare the tools it runs itself in `hello` (`capabilities.tools`). Their calls (capability `harness`) are journaled like built-ins, and the log records a real `tool.completed` instead of `tool.unavailable`.
- **Who wrote each event.** The writer sets an event's `source` and `evidence`; the event's type no longer decides them. Events written before this release still say `loop` or `api`.
  - **`client`**: a command, with a new `principal` taken from its credential.
  - **`harness`**: what a harness reported, with its harness id and `runId`. Evidence `claimed`.
  - **`core`**: core's own logic. Evidence `observed`.
- **`effectId` on model calls.** `GET /v1/sessions/{id}/calls/model` returns each call's `effectId`, so a metered call joins the effect journal.
- **The published contract grows.** It adds `HarnessCheckpointSchema` (the checkpoint fields a harness reads), `NativeToolSchema`, the harness id helpers, `HARNESS_TOOLS_CAPABILITY`, `MAX_HARNESS_STATE_BYTES`, and the gate error codes `key_required` and `effect_not_journaled`. It also documents the effect context keys, the model request hash rule and how a turn's status maps to its output method.
