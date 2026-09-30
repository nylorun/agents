import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = {
  core: [],
  harness: ["core"],
  agents: ["core"],
  admin: ["core"],
  runtime: ["core", "harness"],
  studio: ["agents", "admin"],
  nylorun: ["core"],
  cli: ["agents", "admin"],
};
// Substrate SDKs (sandbox, durable execution, streams) stay behind adapter contracts.
const substrates = {
  runtime: ["just-bash", "@restatedev/restate-sdk", "@s2-dev/streamstore"],
};
// The HTTP framework stays in the HTTP layer: the Host and the API routes.
const httpFramework = {
  runtime: { packages: ["hono", "@hono/[^/\"']+", "@asteasolutions/[^/\"']+"], dirs: ["host", "api"] },
};
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]
  );
export function checkBoundaries(name) {
  const pkg = JSON.parse(
    readFileSync(join(root, name, "package.json"), "utf8")
  );
  for (const dependency of Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  })) {
    if (
      dependency.startsWith("@nylorun/") &&
      !allowed[name].includes(dependency.slice(9))
    )
      throw new Error(`${name} must not depend on ${dependency}`);
  }
  for (const directory of [
    "src",
    "dist",
    ...(name === "studio" ? ["web/src"] : []),
  ])
    for (const path of files(join(root, name, directory))) {
      if (!/\.(?:ts|tsx|js)$/.test(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(
        /(?:from\s*|import\s*\(|export\s*\*\s*from\s*)["'](@nylorun\/([^/"']+)[^"']*)["']/g
      )) {
        if (!allowed[name].includes(match[2]))
          throw new Error(`${path} imports forbidden ${match[1]}`);
        if (
          !Object.hasOwn(
            {
              ...pkg.dependencies,
              ...pkg.peerDependencies,
              ...pkg.optionalDependencies,
            },
            `@nylorun/${match[2]}`
          )
        )
          throw new Error(`${path} imports undeclared ${match[1]}`);
      }
      for (const substrate of substrates[name] ?? []) {
        const pattern = new RegExp(`(?:from\\s*|import\\s*\\()["']${substrate}(?:/[^"']*)?["']`);
        if (pattern.test(source) && !/[\\/]adapters[\\/]/.test(path.slice(join(root, name).length)))
          throw new Error(`${path} imports ${substrate}; only adapters/ may import substrate SDKs`);
      }
      const http = httpFramework[name];
      if (http) {
        const pattern = new RegExp(`(?:from\\s*|import\\s*\\()["'](?:${http.packages.join("|")})(?:/[^"']*)?["']`);
        const [, top] = path.slice(join(root, name).length).split(/[\\/]/).slice(1);
        if (pattern.test(source) && !http.dirs.includes(top))
          throw new Error(`${path} imports the HTTP framework; only ${http.dirs.join("/ and ")}/ may`);
      }
      if (name === "core" && /(?:from\s*|import\s*\()["']node:/.test(source))
        throw new Error(`Core must remain portable: ${path}`);
    }
  // The nylorun package owns `nylorun`; the Runtime is a library and an image, with no bin.
  if (name === "runtime" && pkg.bin !== undefined)
    throw new Error("Runtime must have no bin: the nylorun package owns nylorun, and the Runtime runs as the ghcr.io/nylorun/runtime image");
  // One package per command: nylorun (setup) and @nylorun/cli (nylo) never share a bin.
  if (name !== "nylorun" && pkg.bin?.nylorun !== undefined)
    throw new Error(`${name} must not declare the nylorun bin: the nylorun package owns it`);
  // Studio ships only as the ghcr.io/nylorun/studio image, never to npm.
  if (name === "studio" && (pkg.private !== true || pkg.bin !== undefined))
    throw new Error("Studio must be private with no bin: it ships only as the ghcr.io/nylorun/studio image");
  console.log(`${name}: package, source and declaration dependencies passed.`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  for (const name of Object.keys(allowed)) checkBoundaries(name);
