---
"@nylorun/runtime": patch
---

**A `500 internal_error` is logged.** The Tenant API, the gates listener and the keys service log an unexpected error through the Tenant's or the gate's logger as `request_failed` (`keys_request_failed` for a keys operation), with the method, the route's pattern and the error's message and stack, never a request body, header or argument. The answers are unchanged.
