---
"@nylorun/core": minor
"@nylorun/agents": minor
---

**Studio embedding contract.** `@nylorun/core/contracts` defines the contract between Studio and an app that embeds it in an iframe, and `@nylorun/agents/studio-embed` re-exports it for Studio's web app and embedders such as Babai Desktop.

- `StudioEmbedMessageSchema`: every `postMessage` between the two, on the envelope `{ type: "nylorun.studio", protocol, kind }`. Kinds: `ready`, `init`, `token.refresh`, `theme.changed`, `navigate`, `session`, `token.expiring`, `route.changed`, `open.external`, `open.babai`, `error`. `STUDIO_EMBED_PROTOCOLS` is `[1]`.
- `StudioLoginTokenRequestSchema` and `StudioLoginTokenResponseSchema` for `POST /_studio/login-tokens` (now with optional `tenant` and `subject`), and `StudioSessionRequestSchema` and `StudioSessionResponseSchema` for `POST /_studio/sessions`.
- `parseFrameAncestors` and `isFrameAncestor` validate `NYLORUN_STUDIO_FRAME_ANCESTORS`: exact origins only, no wildcards, keywords, scheme-only entries or paths.
