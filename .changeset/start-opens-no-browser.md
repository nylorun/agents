---
"nylorun": patch
---

**`nylorun start` opens no browser.** `start` (and `up`) prints the Runtime and Studio URLs, says to run `nylorun studio` to sign a browser in to Studio, and ends with a pointer to `nylorun --help`. It no longer mints a Studio login token or opens Studio, also in a terminal. `--no-open` is still accepted and ignored. `nylorun studio` signs a browser in as before.
