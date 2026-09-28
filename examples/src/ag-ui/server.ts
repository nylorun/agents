import { createServer } from "node:http";
import { createSupportApp } from "./app.js";

const app = createSupportApp();
await app.connection.ready;
const port = Number(process.env.PORT ?? 3000);
createServer(app.listener).listen(port, () => {
  console.log(`AG-UI endpoint: http://localhost:${port}/api/agui/support`);
});
