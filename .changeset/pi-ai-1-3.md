---
"@nylorun/runtime": patch
"nylorun": patch
---

The model catalog comes from pi-ai 1.3.0, which adds Gemini 4 Argon: `google-vertex/gemini-4-argon` on Google's Agent Platform (Vertex AI) and `google/gemini-4-argon` on the Gemini API, with a 1,048,576-token context and thinking. `nylorun tenant models set --provider google-vertex --model gemini-4-argon` takes a Google Cloud API key for the Agent Platform API; the Runtime still reads no ambient Google credentials.
