import { createServer } from "node:http";
import { createActionHandler } from "@nylorun/agents";
import { agents } from "../agents/index.js";

// The Runtime delivers each tool call to this URL. On the local stack `localhost` means this
// machine; in production set NYLORUN_ACTIONS_URL to the URL the Runtime reaches this app at.
const port = Number(process.env.PORT ?? 3001);
const url = process.env.NYLORUN_ACTIONS_URL ?? `http://localhost:${port}/nylorun/actions`;

const actions = createActionHandler({ agents, url });
const server = createServer(actions.node);
await new Promise<void>((resolve) => server.listen(port, resolve));
// `tsx watch` often emits a delayed change after the first listen; keep the
// server up and retry so a raced ping does not exit the process.
for (let attempt = 0; ; attempt++) {
  try {
    await actions.register({ url });
    break;
  } catch (error) {
    if (attempt >= 8) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** Math.min(attempt, 3)));
  }
}
console.log(`Serving Actions at ${url}`);
