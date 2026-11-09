---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

An agent sees the images and PDFs it makes in its sandbox (ADR-139). `read` of a file the turn's model reads as media, known by its extension (an image, a PDF, an Office document, audio or video), comes back as the file itself, shown to the model in the turn's files, instead of numbered lines of decoded bytes. Our engine runs it in the harness: it reads the bytes, checks they start as the type says, and stores them as an artifact for the model only. A model that can't read the kind is told so before anything is read or stored (`sandbox.unreadable`), and a file that isn't what its name says fails `sandbox.binary_file`.

- **Model-only artifacts.** `artifact.write` `begin` takes `audience: "model"` (Harness API 5, schema revision 5, `harness-api/v5.5.json`; only our own engine sends it). Such an artifact is readable by id and carries `audience: "model"` in its view and its `artifact.created` event, but is never listed (`GET /v1/artifacts`, a session's artifacts, pages) and is no A2A task file. Runtime store migration 0046 (`artifacts.audience`, nullable) runs at start.
- **Binary files.** The sandbox's `read` of any other binary file fails `sandbox.binary_file`, in words, instead of answering decoded bytes as text.
- **A cap per call.** A model call carries at most the 6 newest files from tool results as media; older ones in the same turn go as a note naming them, which `read_artifact` brings back. A person's own files are never capped.
- `read`'s description says what it now does, so the prompt prefix of every agent with a sandbox changes once: its first call after the upgrade misses the prompt cache.
