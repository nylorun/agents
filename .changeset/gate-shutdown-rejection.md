---
"@nylorun/runtime": patch
---

**A gateway shutdown no longer leaves an unhandled rejection.** When a keyed MCP or HTTP tool call was re-sent and the re-send's client went away before the gateway joined the running call, closing the gateway mid call rejected that join with nobody listening ("The gateway is shutting down"), which Node reports as an unhandled rejection. The gateway now handles it: the call still stops on shutdown and the next gateway sends it again under its key, as before.
