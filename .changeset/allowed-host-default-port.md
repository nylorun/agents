---
"@nylorun/runtime": patch
---

The Runtime accepts a `Host` header with no port when `NYLORUN_ALLOWED_HOSTS` lists that name with
port 443 or 80, as a load balancer or ingress in front of it sends it. The Helm chart lists
`ingress.host` as `<host>:443`, which the Runtime requires (it refused to start with `ingress.host` set).
