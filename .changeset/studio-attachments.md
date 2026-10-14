---
"@nylorun/studio": minor
---

**Attach files to a message.** The message card has a paperclip, and a paste or a drop onto the card attaches files too. Each file shows as a chip, an image's thumbnail or a file icon with its name and size, until the message is sent. The picker offers what the active model reads, from its provider's `inputs` (text and images when the Runtime does not say). Files go as they are: Studio resizes and converts nothing. On **Send** each file is uploaded into the session, then the message goes as text and file parts. When the model does not read a file (`422 attachment_unsupported`), the draft and its chips stay, the refused chips say why, and a resend does not upload the other files again. In the chat, a message's files show their name, type and an image's thumbnail, and open the artifact. The Events table sums up such a message as its text and how many files it carries.

The proxy streams an attachment to `POST /v1/artifacts`, keeping only `name` and `sessionId`, into a session that exists; it needs a `Content-Length` and refuses a file over `maxUploadBytes` (a new Studio server option, 32 MiB by default). It also allows `PUT /v1/tenant/models/inputs` for Model settings.

**Model inputs in Model settings.** Each connected provider's model has an **Inputs** line: what its catalog reads is checked and fixed, and what the operator may add (`addableInputs`) toggles through `models.setInputs()`. The custom endpoint's form has Images, PDF, Audio and Video checkboxes, saved in `settings.inputs` and restored when the form opens. The provider form now scrolls when it is taller than the window.
