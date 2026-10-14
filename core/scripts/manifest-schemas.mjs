// Writes the agent and environment manifests' JSON Schema documents next to the compiled modules (D63).
import { mkdirSync, writeFileSync } from "node:fs";
import { agentManifestJsonSchema, environmentManifestJsonSchema } from "../dist/manifest-schemas.js";

const dir = new URL("../dist/schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("agent-manifest.schema.json", dir), `${JSON.stringify(agentManifestJsonSchema(), null, 2)}\n`);
writeFileSync(new URL("environment-manifest.schema.json", dir), `${JSON.stringify(environmentManifestJsonSchema(), null, 2)}\n`);
