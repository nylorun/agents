---
"@nylorun/create-agent": patch
---
The starter's `npm run dev` no longer passes `--dev`, which `src/main.ts` stopped reading when the Agent began tracking its manifest, and its README empties the Tenant with `npx nylorun tenant reset --all` instead of `npx -p nylorun nylo reset --all`, which exits 2.
