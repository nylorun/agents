---
"nylorun": minor
"@nylorun/studio": minor
---

**The Studio proxy is removed, and Restate runs with its own memory defaults.** Each Tenant's Studio is at `http://localhost:<port>` again (`nylorun studio --tenant <name>` opens it signed in): its own session cookie already keeps it apart from other Studios, so the proxy only added a container and a second address. The 256 MiB RocksDB cap did not lower Restate's memory, so it is gone. The first command of this release removes the proxy that 0.6 started (`nylorun-proxy` and `~/.nylorun/proxy/`); `NYLORUN_PROXY_PORT`, `NYLORUN_PROXY_DISABLED`, `studio.proxyUrl` and Studio's `NYLORUN_STUDIO_PUBLIC_ORIGINS` are gone.
