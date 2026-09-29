---
"nylorun": minor
"@nylorun/studio": minor
"@nylorun/create-agent": patch
---

`nylorun up` prints Studio as `http://localhost:<port>`, with no login token in it, and in a terminal opens Studio in the browser already signed in (`--no-open` keeps the browser closed). The Studio sign-in lasts 30 days and survives Studio restarts: the session cookie is signed with a key derived from the admin key instead of being held in memory. `nylorun studio` prints the plain URL when it opens the browser; `nylorun studio --no-open` still prints the single-use login URL.
