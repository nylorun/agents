// Writes agent manifest v8's and its authoring files' JSON Schema documents next to the compiled
// modules, and those of each kind of file in an agent folder under schemas/agent-folder/.
import { mkdirSync, writeFileSync } from "node:fs";
import {
  agentManifestJsonSchema,
  harnessManifestJsonSchema,
  runtimeManifestJsonSchema,
} from "../dist/manifest-schemas.js";
import { agentFolderJsonSchemas } from "../dist/folder/index.js";

const dir = new URL("../dist/schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("agent-manifest.schema.json", dir), `${JSON.stringify(agentManifestJsonSchema(), null, 2)}\n`);
writeFileSync(new URL("harness-manifest.schema.json", dir), `${JSON.stringify(harnessManifestJsonSchema(), null, 2)}\n`);
writeFileSync(new URL("runtime-manifest.schema.json", dir), `${JSON.stringify(runtimeManifestJsonSchema(), null, 2)}\n`);

const folder = new URL("agent-folder/", dir);
mkdirSync(folder, { recursive: true });
for (const [kind, schema] of Object.entries(agentFolderJsonSchemas()))
  writeFileSync(new URL(`${kind}.schema.json`, folder), `${JSON.stringify(schema, null, 2)}\n`);
