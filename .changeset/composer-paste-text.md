---
"@nylorun/studio": patch
---

Studio's message box inserts the text a paste carries instead of letting the browser read the clipboard again. Dictation tools that paste and then put the clipboard back (Wispr Flow in Chrome) lost that race after the first message: nothing went in, or the clipboard's earlier text did.
