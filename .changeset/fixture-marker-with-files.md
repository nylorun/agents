---
"@nylorun/runtime": patch
"@nylorun/harness": patch
---

The fixture model reads its `fixture:*` script in a turn that carries a file. Our harness ends such a turn with a user message listing the files (`FILES_MESSAGE_HEADER`, now exported by `@nylorun/harness`), and the fixture model read that message instead: it answered "I remember: …" and called no tool. It now skips that message, for the script and for the tool result it answers after.
