---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

The A2A endpoint serves the Nylorun A2A profile v2 (Host feature `a2a-profile-v2`, Engine R1).

- **Push notifications.** The four push config methods and `configuration.taskPushNotificationConfig` in `SendMessage`. Each task update is POSTed as one A2A `StreamResponse`, at least once, with `X-A2A-Notification-Token` and Standard Webhooks signatures (`webhook-id`, `webhook-timestamp`, `webhook-signature`) made with the new Runtime config `a2a.push.secret` (`NYLORUN_A2A_PUSH_SECRET`, `whsec_…`). Private hosts must be listed in `a2a.push.allowHosts` (`NYLORUN_A2A_PUSH_ALLOW_HOSTS`, `host:port` or `host:*`). Failed pushes are retried with backoff for 24 hours (Host tuning `a2a.pushRetry`, `a2a.pushMaxAgeMs`), then dropped. Configs and pushes live in two new tables (migration 0039).
- **Queued follow-ups.** A message to a busy context is queued and answered with the task that takes it (`TASK_STATE_SUBMITTED`); `metadata.delivery: "reject"` keeps `UnsupportedOperationError` with reason `CONTEXT_BUSY`.
- **Interactions.** Approvals and connection asks are `AUTH_REQUIRED`, questions `INPUT_REQUIRED`, shown under `interactions/v1`; an answer on the same task (`{ interactionId, approved }` or `{ interactionId, value }`) maps to `approve` or `respond`, with the caller as `approvedBy`. Text never approves.
- **Progress, telemetry, effects.** `plan.updated` events become `progress/v1`; the terminal status carries `telemetry/v1` (totals and trace id); an uncertain effect `effects/v1`.
- **Files.** `url` parts are fetched and stored like `raw` ones; the files a task writes are artifacts whose `url` points at the new `GET /v1/a2a/files/{artifactId}/versions/{version}`, served only to the same subject, with `files/v1`.
- **Extensions and card.** `A2A-Extensions` activates the five extensions and is echoed; data of the others is left out. The card lists the Runtime's JSON-RPC interface (A2A 1.0), `streaming: false`, `pushNotifications`, and the five extensions (`required: false`).
- ProtoJSON's original field names (`task_id`) are accepted in A2A params.
