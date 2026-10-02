---
"@nylorun/runtime": minor
---

**The gates service.** `--service gates` starts the Model Gate: one listener (`NYLORUN_GATES_LISTEN_HOST`, `NYLORUN_GATES_LISTEN_PORT`, default port 4100, `NYLORUN_GATES_ALLOWED_HOSTS`) that serves `POST /nylorun/v1/model-calls` to callers presenting `NYLORUN_GATES_TOKEN`. It reads the Tenant's host model from its vault and calls the provider with the same adapter, retries and redaction as before, and answers with one JSON body once the call has finished. Nothing calls it yet.

- The gate needs only `NYLORUN_DATABASE_URL` and the Host's Tenant directory (`tenant/`), which it never writes: it runs no migration, opens no Tenant runtime and creates no vault key. It refuses a Tenant whose schema is at another version.
- gates never shares a process with core or loop: `--service core,gates` is refused.
- A process that runs only gates ignores `NYLORUN_LISTEN_*` and the operator listener settings.
