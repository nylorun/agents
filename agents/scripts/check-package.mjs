import { registerHooks } from "node:module";
const loaded = [];
const hooks = registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
try {
  const { checkBoundaries } = await import(
    "../../scripts/check-boundaries.mjs"
  );
  checkBoundaries("agents");
  // Studio's web app imports the embed contract: it loads no Node-only module either.
  const embedStart = loaded.length;
  const embed = await import("@nylorun/agents/studio-embed");
  if (typeof embed.parseFrameAncestors !== "function" || !embed.StudioEmbedMessageSchema)
    throw new Error("Missing @nylorun/agents/studio-embed exports");
  const embedNodeOnly = loaded.slice(embedStart).filter((url) => url.startsWith("node:"));
  if (embedNodeOnly.length)
    throw new Error(`Studio embed entry loaded Node-only modules: ${embedNodeOnly.join(", ")}`);
  const sdk = await import("@nylorun/agents");
  for (const name of ["Agent", "createClient", "http"])
    if (typeof sdk[name] !== "function")
      throw new Error(`Missing SDK export ${name}`);
  // Executors were removed in protocol 3, subject tokens and the browser client in protocol 7,
  // Action endpoints in protocol 8 (track R2): no such export or subpath remains.
  for (const name of [
    "connectAgents",
    "createActionHandler",
    "createActionSandbox",
    "deriveExecutorToken",
    "createTokenEndpoint",
    "createBrowserClient",
    "TokensClient",
    "PublishableKeysClient",
  ])
    if (name in sdk) throw new Error(`Removed SDK export ${name} is still exported`);
  const browserEntry = await import("@nylorun/agents/browser").then(
    () => true,
    () => false
  );
  if (browserEntry)
    throw new Error("Removed subpath @nylorun/agents/browser still resolves");
  const executorEntry = await import("@nylorun/agents/executor").then(
    () => true,
    () => false
  );
  if (executorEntry)
    throw new Error("Removed subpath @nylorun/agents/executor still resolves");
  const execution = loaded.filter((url) =>
    /[/\\](?:harness|runtime|cli)[/\\](?:src|dist)[/\\]/.test(url)
  );
  if (execution.length)
    throw new Error(`SDK loaded execution modules: ${execution.join(", ")}`);
  // Only `@nylorun/agents/ag-ui` loads the AG-UI protocol package.
  const agUi = loaded.filter((url) => /[/\\]@ag-ui[/\\]/.test(url));
  if (agUi.length)
    throw new Error(`SDK entry point loaded AG-UI modules: ${agUi.join(", ")}`);
  // `@nylorun/agents/a2a` forwards to the Runtime: it loads no A2A or AG-UI package.
  const a2a = await import("@nylorun/agents/a2a");
  if (
    typeof a2a.createA2aHandler !== "function" ||
    typeof a2a.toNodeListener !== "function"
  )
    throw new Error("Missing @nylorun/agents/a2a exports");
  const protocols = loaded.filter((url) => /[/\\]@(?:ag-ui|a2a-js)[/\\]/.test(url));
  if (protocols.length)
    throw new Error(`A2A entry loaded protocol packages: ${protocols.join(", ")}`);
  const { createAgUiHandler, toNodeListener } = await import(
    "@nylorun/agents/ag-ui"
  );
  if (
    typeof createAgUiHandler !== "function" ||
    typeof toNodeListener !== "function"
  )
    throw new Error("Missing @nylorun/agents/ag-ui exports");
  console.log(
    "SDK entry point imports; no engine, host or AG-UI modules loaded; the A2A entry loads no protocol package; the Studio embed entry loads no Node-only module."
  );
} finally {
  hooks.deregister();
}
