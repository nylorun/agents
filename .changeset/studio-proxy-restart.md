---
"@nylorun/studio": patch
---

Restart on vN and Retry vN work again. Studio's proxy forwards `POST /v1/agents/{id}/restart` (with `retry`) to the Runtime, as it forwards stop and reset, instead of answering `404 Unsupported Studio operation`.
