import { createServer } from "node:http";
import { createSupportApp } from "./app.js";

const app = createSupportApp();
const port = Number(process.env.PORT ?? 3000);
createServer(app.listener).listen(port, async () => {
  await app.register(process.env.NYLORUN_APP_URL ?? `http://localhost:${port}`);
  console.log(`AG-UI endpoint: http://localhost:${port}/api/agui/support`);
});
