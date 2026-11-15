---
"@nylorun/runtime": patch
---

The Runtime's Helm chart, as tested on GKE with Cloud SQL and GCS: tokens and the admin key as 32
bytes of hex (a kept value in another form is replaced); the Restate worker and the Harness API
through `<name>-runtime-internal`, which publishes the runtime before it is ready; probes with a
loopback `Host`; Studio's image by its own version (`nylorun.com/studio-version`, kept by the
release); an external Postgres needs no C-collation database.
