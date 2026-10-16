---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/admin": patch
"nylorun": minor
---

Webhook triggers (track T4, D75). A `webhook: "standard-webhooks"` trigger has an endpoint, `POST /v1/webhooks/{endpointId}`, an anonymous, unversioned route that takes any body up to the new Runtime limit `webhookBodyBytes` and verifies Standard Webhooks (`webhook-id`, `webhook-timestamp` within the Host's `triggers.webhookToleranceMs`, `webhook-signature`) in the keys service, which alone opens the trigger's sealed secret; anything else is `401` and writes nothing. A delivery runs the trigger once per `webhook-id` (`202 {runId, status}`); a paused trigger answers a signed one `409 trigger_paused`. `POST /v1/agents/{id}/triggers/{triggerId}/secret` makes or replaces the `whsec_` secret, shown once (`agent.trigger_secret_rotated`); trigger reads show `webhookUrl` and `secretSet`. The payload reaches the model under the trigger's prompt in a labelled `<trigger-payload>` block. The SDK adds `agents.rotateWebhookSecret`, and the CLI `nylorun agents triggers new-secret`.
