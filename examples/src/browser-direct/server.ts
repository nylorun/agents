import { createServer } from "node:http";
import { createClient } from "@nylorun/agents";
import { createDirectApp } from "./app.js";
import { setUpAccess } from "./setup.js";

const client = await createClient();
const { publishableKey } = await setUpAccess(client);
const app = createDirectApp({
  client,
  runtimeUrl: process.env.NYLORUN_PUBLIC_RUNTIME_URL ?? client.transport.url,
  publishableKey,
});
const port = Number(process.env.PORT ?? 3001);
createServer(app.listener).listen(port, async () => {
  await app.register(process.env.NYLORUN_APP_URL ?? `http://localhost:${port}`);
  console.log(`Token route: http://localhost:${port}/api/nylorun/token`);
  console.log(`Page config: http://localhost:${port}/api/nylorun/config`);
  console.log("Pages call the Runtime directly: see src/browser-direct/chat.ts.");
});
