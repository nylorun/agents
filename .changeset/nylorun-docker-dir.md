---
"nylorun": minor
---

**The Docker Compose files live in `~/.nylorun/docker/`.** `compose.yaml`, `.env` and `restate-identity.pem` moved from `~/.nylorun/stack/` (or `$NYLORUN_HOME/stack/`) to `docker/`, so the folder says what it holds. The first `nylorun` command after upgrading moves the folder as it is: ports, the Postgres password, the gates token and the Restate identity are kept, and so are volumes and Tenants. The next `nylorun up` recreates the `restate` container, whose identity key is now mounted from the new path. Scripts that read `stack/.env` read `docker/.env` instead.
