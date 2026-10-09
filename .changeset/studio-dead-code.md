---
"@nylorun/studio": patch
---

**Studio: a malformed agent or session URL is "not found", not a crash.** A route segment that is no valid percent-encoding (`/tenants/<id>/agents/%E0`, reached by in-app or embedder navigation) threw a URIError while the dashboard rendered, and the error panel it left survived navigation. Studio now decodes route segments the way it already decodes the Tenant id, so such a URL shows "Agent not found" or "Session not found", and the outer error panel clears on the next route like the inner one does. Dead code is gone: the unused chat composer, the `textarea` and `skeleton` UI components, unused `sidebar`, `card`, `sheet` and `table` exports, and the old Studio discovery protocol module (`studio/src/protocol.ts`), which nothing served or read.
