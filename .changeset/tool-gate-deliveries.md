---
"@nylorun/runtime": minor
"nylorun": minor
---

**Action deliveries leave through the gateway (F4.1).** With the gates service, every delivery and endpoint ping is POSTed by the gateway (`POST /nylorun/v1/deliveries`) under the gateway's own `NYLORUN_ENDPOINT_*` policy. The delivery state machine is unchanged. A gateway that cannot be reached counts as a delivery that was not sent, so it is retried, and its failure code is `gateway.unreachable`.

- `nylorun`: the `gateway` container now sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host`, so Action endpoints on this machine stay reachable.
- A process that runs only `core` also reads `NYLORUN_GATES_URL`, for endpoint pings.
