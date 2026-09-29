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
  // First, before anything else is cached: the browser entry loads no Node-only module.
  const start = loaded.length;
  const browser = await import("@nylorun/agents/browser");
  if (typeof browser.createBrowserClient !== "function")
    throw new Error("Missing @nylorun/agents/browser exports");
  const nodeOnly = loaded.slice(start).filter(
    (url) => url.startsWith("node:") || /[/\\]connection\.js$/.test(url)
  );
  if (nodeOnly.length)
    throw new Error(`Browser entry loaded Node-only modules: ${nodeOnly.join(", ")}`);
  const sdk = await import("@nylorun/agents");
  for (const name of ["Agent", "createClient", "connectAgents"])
    if (typeof sdk[name] !== "function")
      throw new Error(`Missing SDK export ${name}`);
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
    "SDK entry point imports; no engine, host or AG-UI modules loaded; the A2A entry loads no protocol package; the browser entry loads no Node-only module."
  );
} finally {
  hooks.deregister();
}
