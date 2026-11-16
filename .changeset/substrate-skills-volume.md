---
"@nylorun/runtime": patch
---

An Agent Substrate computer (and pod) mounts a `skills` volume at `/skills`, as the pods driver
does. An image that runs as a user other than root, such as `ghcr.io/nylorun/dev` (1000:1000),
couldn't create `/skills` at the root, so its engine never started and the computer crashed on
every wake.
