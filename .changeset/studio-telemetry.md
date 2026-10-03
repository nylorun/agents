---
"nylorun": minor
"@nylorun/studio": minor
---

**Studio reports anonymous page views, unless you opt out.** Studio sends page views to Google Analytics with every Tenant, agent and session id replaced by `:id` and the query dropped; nothing sent to agents is collected. `nylorun start` says so once, and passes the measurement id to the Studio container as `NYLORUN_STUDIO_ANALYTICS_ID`. Turn it off with `nylorun telemetry disable`, `NYLORUN_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; it is always off in CI, inside an embedding app, and when the browser sends Do Not Track or Global Privacy Control.
