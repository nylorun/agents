import { developmentOptions, develop } from "./lib/development.mjs";
import { verifyToolchain } from "./lib/repo.mjs";

try {
  const options = developmentOptions(process.argv.slice(2));
  await verifyToolchain();
  const controller = new AbortController();
  let app;
  const stop = () => {
    controller.abort();
    if (app) void app.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // The Tenant is examples/' own: named after the directory unless
  // NYLORUN_TENANT names one, under ~/.nylorun/tenants/<name>/ (NYLORUN_HOME
  // overrides) as Compose project nylorun-<name> (NYLORUN_COMPOSE_PROJECT
  // overrides). It outlives npm run dev.
  app = await develop(options, { signal: controller.signal });
  if (controller.signal.aborted) await app.close();
  process.exitCode = await app.done;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
