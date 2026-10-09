#!/usr/bin/env node
import "./baseline.js";
import { runCommand } from "./command.js";

// `nylo`, the Runtime client (client/). `nylorun`'s entry never imports it, so `npx nylorun start`
// loads none of it, nor @nylorun/admin.
runCommand(async () => {
  const { main } = await import("./client/cli.js");
  await main(process.argv.slice(2));
});
