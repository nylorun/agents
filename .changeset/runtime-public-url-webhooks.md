---
"@nylorun/runtime": patch
"nylorun": patch
---

Webhook URLs name the Runtime's public URL. A trigger's `webhookUrl` is at `NYLORUN_PUBLIC_URL`, else the origin the request reached, so behind a reverse proxy that rewrites `Host` to `localhost:<port>` it is the proxy's URL, not `http://localhost:<port>`; the Runtime API's `401` challenges name it too. `nylorun start` passes `NYLORUN_PUBLIC_URL` from its shell to the runtime container (default `http://localhost:<port>`).
