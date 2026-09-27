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
  checkBoundaries("admin");
  const sdk = await import("@nylorun/admin");
  for (const name of ["createAdmin", "AdminError", "deriveStudioToken"])
    if (sdk[name] === undefined)
      throw new Error(`Missing admin export ${name}`);
  const forbidden = loaded.filter((url) =>
    /[/\\](?:harness|runtime|cli|agents)[/\\](?:src|dist)[/\\]/.test(url),
  );
  if (forbidden.length)
    throw new Error(
      `Admin loaded forbidden modules: ${forbidden.join(", ")}`,
    );
  console.log("Admin entry point imports; boundaries and exports ok.");
} finally {
  hooks.deregister();
}
