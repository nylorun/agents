---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
"@nylorun/studio": patch
"nylorun": patch
---

The Tenant's sandbox settings round-trip, and `engine.images` comes back (#588).

- **Breaking (`@nylorun/runtime`, `@nylorun/core`, `@nylorun/admin`): `config` is the settings as stored.** `GET` and `PUT /v1/tenant/sandbox` (`admin.settings.sandbox`) answer `config` as the Tenant set it, with no defaults, in exactly the shape `PUT` takes (`limits.resources.memory: "8GiB"`), so `put(get().config)` changes nothing and saves no default as a setting. The settings in force, every default filled in and sizes in MiB (`memoryMiB`), are `effective`, which is what `config` was. Before, `PUT` refused what `GET` answered (`unrecognized_keys "memoryMiB"`). Read the settings in force from `effective` (`view.effective.limits.resources.memoryMiB`), and build a `PUT` body from `view.config`. `TenantSandboxViewSchema` has `config: TenantEnvironmentsConfigSchema` and `effective: EffectiveSandboxConfigSchema`.
- **`engine.images` is answered.** A `PUT` with `engine.images` was stored and used, but left out of its answer and of the next `GET`. Both now carry it, in `config` as set and in `effective` (`[]` when unset).
- `@nylorun/studio`: Edit compute settings puts the stored settings with only the fields it changed, so it no longer erases `engine.images` set through the API, keeps `placement`, and saves no default as a setting; clearing idle, stop grace or most Agents puts back the default. The Compute tab lists the engine images.
- `nylorun`: `nylorun tenant settings sandbox put` takes what `get` printed and puts back its `config`. `nylorun doctor sandbox` reads the limits in force from `effective`, or from `config` on an older Runtime.
