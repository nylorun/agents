---
"@nylorun/agents": minor
"@nylorun/create-agent": minor
"nylorun": minor
---

**New projects serve their tools as an Action endpoint.** Everything Nylorun ships now uses Action endpoints instead of executors. `connectAgents` still works, but it is deprecated.

- **Starter (`create-agent`).** `src/main.ts` serves the agents with `createActionHandler` on `http://localhost:3001/nylorun/actions` (`PORT`, `NYLORUN_ACTIONS_URL`) and registers it. `npm run dev` and `npm start` work as before. The README explains which URL the Runtime must reach.
- **Local stack (`nylorun`).** The Runtime container sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host` and maps `host.docker.internal` to the Docker host, so a `localhost` endpoint on the developer's machine is reachable, on Linux Docker Engine too.
- **Examples.** The AG-UI and browser-direct apps serve their Action endpoint at `/nylorun/actions` beside their other routes, and `register(origin)` replaces `connection.ready`.
- **Docs.** The README, `DEPLOYMENT.md` and the `@nylorun/agents` README describe Action endpoints.
