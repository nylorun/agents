---
"@nylorun/studio": minor
---

Studio shows and uploads agent folders (track T7).

- **From folder.** A manifest version saved from an agent folder is marked beside its number in the Manifests table, and in the pane's subtitle.
- **Source.** The manifest pane has two views, **Spec** and **Source** (`&view=source`). Source is the folder the version was saved from, read only: its files as a tree, each marked when it was added or changed since the version before (`source/diff`), the removed ones last; a file opens beside it as text, or as its size when it is not text. A version saved as JSON says it has no source.
- **Upload folder…** on the Manifests toolbar picks a directory in the browser (leaving out `.git`, `.hg`, `.svn` and `node_modules`), hashes each file with WebCrypto, uploads the ones the Runtime does not hold by hash, and shows the plan of saving it (changes, errors, warnings and the compiler's diagnostics by file, line and column) before **Save v<n>** saves it under `If-Match`. The manifest takes the name `AGENT.md` gives it.
- The proxy allows a version's source reads, `source/diff`, `HEAD` and same-origin `PUT /v1/files/sha256:<hex>`, and a manifest save sent as `application/vnd.nylorun.folder+json`; a source file is delivered as a download.
- The Limits tab has an **Agent folders** group: `folderFiles`, `folderBytes` and `folderTextFileBytes`.
- The manifests list shows beside an open manifest only where both fit, so its columns no longer run under the pane, and a long note on a status (such as a tool policy rule) ends in an ellipsis instead of running over its row.
