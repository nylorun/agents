---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/admin": minor
"@nylorun/runtime": minor
"nylorun": minor
---

**Runtime limits are a Tenant setting, and harnesses get them in `turn.start.limits`.**

- What one record entry, model call, model file, tool answer, custom harness state and Harness API chunk may hold is the new Management API setting `GET`/`PUT /v1/tenant/limits` (`{ limits: { recordEntryBytes, modelCallBytes, modelFileBytes, toolAnswerBytes, harnessStateBytes, chunkBytes } }`), also `admin.settings.limits` and `nylorun tenant settings limits [get | put <file|->]`.
  - The defaults are today's sizes (`RUNTIME_LIMIT_DEFAULTS`): 960 KiB, 32 MiB, 8 MiB, 8 MiB, 256 KiB and 16 MiB. A limit left out of a `PUT` takes its default.
  - Each limit has a ceiling a dependency sets (`RUNTIME_LIMIT_CEILINGS`): S2's 1 MiB record less 64 KiB for the event's envelope, the 64 MiB Harness API frame, the longest JavaScript string. A limit above its ceiling is `400`, naming the ceiling.
  - Each is read from the Tenant's database where it is checked; nothing keeps it.
- **The record holds every write to `recordEntryBytes`.** An event whose payload, or an effect outcome whose value, is larger, whoever wrote it, is refused with `limit_exceeded`: `413` (`details.limit: "recordEntryBytes"`) to an API client, the new Harness API error code `limit_exceeded` to a harness. A harness's claimed event past it is refused rather than dropped. Before, such an event reached a record S2 could not take.
- **The gates read the setting.** The Model Gate refuses a body past `modelCallBytes` and a file past `modelFileBytes`; the Tool Gate keeps no MCP or HTTP answer past `toolAnswerBytes` (`mcp.too-large`, `http.too-large`) and reads no tool body past it. A custom harness's state past `harnessStateBytes` fails its turn with `limit_exceeded` (it was `invalid`), and a `definition.file` range longer than `chunkBytes` is `limit_exceeded`. Core's step budget for tool results is unchanged (256 KiB), or half `recordEntryBytes` when that is less.
- **`turn.start` carries `limits`** (`RuntimeLimitsSchema`), the limits in force when the segment started. Harness API 3 and protocol 14 are unchanged, but `TurnStartSchema` is strict: a harness built against an older `@nylorun/core` refuses a `turn.start` with `limits`, so upgrade a custom harness with the Runtime. Our harness asks for skill files `limits.chunkBytes` at a time, and holds MCP answers on its own connections to `limits.toolAnswerBytes`. `createHarness` takes `onStart(grant, start)`.
- **Removed exports:** `MAX_MODEL_CALL_BYTES`, `MAX_TOOL_BODY_BYTES`, `MAX_HARNESS_STATE_BYTES` and `DEFINITION_FILE_CHUNK_BYTES` from `@nylorun/core`. Added: `RuntimeLimitsSchema`, `RUNTIME_LIMIT_DEFAULTS`, `RUNTIME_LIMIT_CEILINGS`, `runtimeLimitsOf`, `runtimeLimitIssues`, `limitExceededMessage`, `S2_RECORD_MAX_BYTES`, `RECORD_ENVELOPE_RESERVE_BYTES`, `JS_STRING_MAX_LENGTH` and the `TenantLimits*` schemas.
