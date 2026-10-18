---
"@nylorun/studio": minor
---

The agent manifests list is one table of single-line rows, like the Agents list and an Agent's page: each manifest's name, description, latest version, kind, Agents and when it was saved, with a search and Kind, Type and Agents filters on top. A row opens the manifest beside the list instead of on its own page (`/agent-manifests?selected=<name>&version=<n>`; `/agent-manifests/<name>` opens it so too): a version picker, the Agents made from it, and the version as a readable spec, its harness section then its runtime section, one line each, a line opening its part of the manifest. Its ⋯ makes an Agent from the version shown, shows the whole manifest as JSON, or copies its name.
