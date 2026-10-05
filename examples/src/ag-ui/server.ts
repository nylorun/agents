import { createServer } from "node:http";
import { createSupportApp } from "./app.js";

const app = createSupportApp();
const port = Number(process.env.PORT ?? 3000);
createServer(app.listener).listen(port, async () => {
  // On a local Tenant the Runtime (in Docker) reaches this machine's `localhost`; elsewhere set
  // NYLORUN_APP_URL to the URL the Runtime reaches this app at.
  await app.save(process.env.NYLORUN_APP_URL ?? `http://localhost:${port}`);
  console.log(`AG-UI endpoint: http://localhost:${port}/api/agui/support`);
});
