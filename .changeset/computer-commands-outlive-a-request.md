---
"@nylorun/runtime": patch
---

A computer (`--service computer`) keeps its commands for its life, not for one request: an attach to a command still running found it gone (`404 unknown_command`), and a start sent again ran the command a second time. A command longer than one attach's wait (50 s) now finishes as it should.
