---
"@nylorun/runtime": minor
"@nylorun/cli": minor
"@nylorun/create-agent": minor
---

**Native Windows is no longer supported; Windows developers use WSL2.** Nylorun runs on macOS and Linux. On native Windows, `nylorun` and `npm create @nylorun/agent` stop with WSL2 guidance. Install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and keep projects in its Linux filesystem. The Windows-only process handling (`taskkill`, `.cmd` shims, `npm.cmd`) is removed. `nylorun doctor` reports WSL as `Linux (WSL: <distribution>)`.
