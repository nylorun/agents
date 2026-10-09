import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = {
  core: [],
  harness: ["core"],
  agents: ["core"],
  admin: ["core"],
  runtime: ["core", "harness"],
  studio: ["agents", "admin"],
  // nylorun: the local Tenants (`nylorun`) and the Runtime client (`nylo`, through admin).
  nylorun: ["core", "admin"],
  // The deprecated @nylorun/cli depends on nylorun only, and runs its `nylo`.
  cli: [],
};
// Substrate SDKs (sandbox, durable execution, streams) stay behind adapter contracts.
const substrates = {
  runtime: [
    "just-bash",
    "@restatedev/restate-sdk",
    "@restatedev/restate-sdk-clients",
    "@s2-dev/streamstore",
    // The stream relay's logical replication (adapters/replication/).
    "pg",
    "pg-logical-replication",
  ],
};
// The streams module (Durable Streams §7.6) depends only on its own contracts: it receives an
// already-authorized Tenant and session, never reaches into tenant, engine, API or store code.
const moduleImports = {
  runtime: [
    { dir: "reads", forbidden: ["core", "execution", "host", "gates", "api"], forbiddenFiles: ["tenant/advance", "tenant/commands", "tenant/scheduler", "tenant/sessions"], except: [] },
    {
      dir: "streams",
      forbidden: ["tenant", "core", "api", "store", "host", "execution"],
      except: [],
    },
    // The record module (blueprint D27) is the write path into the record. It runs its
    // statements through the store's RecordWriter and never imports tenant, engine, API, gate
    // or stream code.
    {
      dir: "record",
      forbidden: ["tenant", "core", "api", "host", "execution", "gates", "streams"],
      except: [],
    },
    // A harness (F6, D37) runs the engine and its calls with what it is given: the executors
    // and the Harness API. It reaches no store, record, key, vault, stream, execution, API or
    // infrastructure code, and never the provider adapter.
    {
      dir: "harness",
      forbidden: ["tenant", "store", "record", "keys", "vault", "streams", "execution", "api", "infra"],
      forbiddenFiles: ["model/pi-"],
      except: [],
    },
  ],
};
// The provider adapter runs behind the Model Gate (blueprint §15): the loop calls the gate and
// never pi-ai, so it never holds a model credential. `node/` and `configuration.ts` re-export
// the adapter for embedders.
const restrictedModules = {
  runtime: [
    {
      modules: ["model/pi-model.js", "model/models.js"],
      importers: ["gates", "model", "node", "configuration.ts"],
    },
    // Reading the host model credential in plaintext: the Model Gate only.
    { modules: ["vault/host-model.js"], importers: ["gates", "vault"] },
  ],
};
// Only the record module inserts into the record, as SQL or through Drizzle's query builder. Its
// two Postgres statements sit behind the driver boundary in store/postgres/record-writer.ts,
// which only the record module calls (`RecordWriter`). Other code may read the record, and the
// store deletes its rows on reset.
const recordInserts = {
  runtime: {
    dirs: ["record"],
    files: ["store/postgres/record-writer"],
    pattern:
      /INSERT\s+INTO\s+[^\n;]{0,80}?(?:SESSION_EVENTS|LOG_HEADS|session_events|session_log_heads|sandbox_events)|\.insert\(\s*(?:sessionEvents|sessionLogHeads|sandboxEvents)\b/,
  },
};
// The HTTP framework stays in the HTTP layer: the Host and the API routes.
const httpFramework = {
  runtime: { packages: ["hono", "@hono/[^/\"']+", "@asteasolutions/[^/\"']+"], dirs: ["host", "api"] },
};
// The Session Store's driver and query builder stay behind store/postgres/ (session-store.md §3):
// postgres.js and drizzle-orm are imported there only; drizzle-kit is a development tool and is
// never imported by shipped code.
const storeDriver = {
  runtime: { packages: ["postgres", "drizzle-orm"], dir: ["store", "postgres"], devOnly: ["drizzle-kit"] },
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
      const relative = path.slice(join(root, name).length + 1).split(/[\\/]/);
      if (relative[0] === "src")
        for (const rule of moduleImports[name] ?? []) {
          if (relative[1] !== rule.dir || rule.except.includes(relative.slice(1).join("/"))) continue;
          for (const match of source.matchAll(/(?:from\s*|import\s*\()["'](\.\.?\/[^"']+)["']/g)) {
            const target = join(dirname(path), match[1]).slice(join(root, name, "src").length + 1);
            const top = target.split(/[\\/]/)[0];
            if (rule.forbidden.includes(top))
              throw new Error(`${path} imports ${match[1]}; ${rule.dir}/ must not import ${top}/`);
            const file = target.split(/[\\/]/).join("/");
            const prefix = (rule.forbiddenFiles ?? []).find((item) => file.startsWith(item));
            if (prefix)
              throw new Error(`${path} imports ${match[1]}; ${rule.dir}/ must not import ${prefix}*`);
          }
        }
      if (relative[0] === "src")
        for (const rule of restrictedModules[name] ?? []) {
          if (rule.importers.includes(relative[1])) continue;
          for (const match of source.matchAll(/(?:from\s*|import\s*\()["'](\.\.?\/[^"']+)["']/g)) {
            const target = join(dirname(path), match[1]).slice(join(root, name, "src").length + 1).split(/[\\/]/).join("/");
            if (rule.modules.includes(target))
              throw new Error(`${path} imports ${match[1]}; only ${rule.importers.join(", ")} may (the Model Gate)`);
          }
        }
      const inserts = recordInserts[name];
      if (inserts && (relative[0] === "src" || relative[0] === "dist")) {
        const inside = relative.slice(1).join("/");
        const allowed =
          inserts.dirs.some((dir) => inside.startsWith(`${dir}/`)) ||
          inserts.files.includes(inside.replace(/\.(?:d\.ts|ts|js)$/, ""));
        if (!allowed && inserts.pattern.test(source))
          throw new Error(`${path} inserts into the record; only record/ may (blueprint D27)`);
      }
      const store = storeDriver[name];
      if (store) {
        const [, ...rest] = path.slice(join(root, name).length).split(/[\\/]/).slice(1);
        const within = store.dir.every((part, index) => rest[index] === part);
        const imports = (packages) =>
          new RegExp(`(?:from\\s*|import\\s*\\()["'](?:${packages.join("|")})(?:/[^"']*)?["']`).test(source);
        if (imports(store.packages) && !within)
          throw new Error(`${path} imports the Session Store's driver; only ${store.dir.join("/")}/ may`);
        if (imports(store.devOnly))
          throw new Error(`${path} imports ${store.devOnly.join(", ")}, a development tool`);
      }
      const http = httpFramework[name];
      if (http) {
        const pattern = new RegExp(`(?:from\\s*|import\\s*\\()["'](?:${http.packages.join("|")})(?:/[^"']*)?["']`);
        const [, top] = path.slice(join(root, name).length).split(/[\\/]/).slice(1);
        if (pattern.test(source) && !http.dirs.includes(top))
          throw new Error(`${path} imports the HTTP framework; only ${http.dirs.join("/ and ")}/ may`);
      }
      // Core is portable, except its Node-only `./project` subpath (the Project link and the Host
      // root on this machine), which no other Core module imports.
      const nodeOnly =
        name === "core" && /^(?:src\/project\.ts|dist\/project\.(?:js|d\.ts))$/.test(relative.join("/"));
      if (name === "core" && !nodeOnly && /(?:from\s*|import\s*\()["']node:/.test(source))
        throw new Error(`Core must remain portable: ${path}`);
      if (name === "core" && !nodeOnly && /(?:from\s*|import\s*\()["']\.\.?\/(?:[^"']*\/)?project\.js["']/.test(source))
        throw new Error(`${path} imports the Node-only project module; Core must remain portable`);
    }
  // The nylorun package owns `nylorun`; the Runtime is a library and an image, with no bin.
  if (name === "runtime" && pkg.bin !== undefined)
    throw new Error("Runtime must have no bin: the nylorun package owns nylorun, and the Runtime runs as the ghcr.io/nylorun/runtime image");
  // nylorun owns its command (and `nylo`); no other package declares the nylorun bin.
  if (name !== "nylorun" && pkg.bin?.nylorun !== undefined)
    throw new Error(`${name} must not declare the nylorun bin: the nylorun package owns it`);
  // Studio ships only as the ghcr.io/nylorun/studio image, never to npm.
  if (name === "studio" && (pkg.private !== true || pkg.bin !== undefined))
    throw new Error("Studio must be private with no bin: it ships only as the ghcr.io/nylorun/studio image");
  console.log(`${name}: package, source and declaration dependencies passed.`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  for (const name of Object.keys(allowed)) checkBoundaries(name);
