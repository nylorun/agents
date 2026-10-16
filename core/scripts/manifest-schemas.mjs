// Writes agent manifest v8's and its authoring files' JSON Schema documents next to the compiled modules.
import { mkdirSync, writeFileSync } from "node:fs";
import {
  agentManifestJsonSchema,
  harnessManifestJsonSchema,
  runtimeManifestJsonSchema,
} from "../dist/manifest-schemas.js";

const dir = new URL("../dist/schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("agent-manifest.schema.json", dir), `${JSON.stringify(agentManifestJsonSchema(), null, 2)}\n`);
writeFileSync(new URL("harness-manifest.schema.json", dir), `${JSON.stringify(harnessManifestJsonSchema(), null, 2)}\n`);
writeFileSync(new URL("runtime-manifest.schema.json", dir), `${JSON.stringify(runtimeManifestJsonSchema(), null, 2)}\n`);
