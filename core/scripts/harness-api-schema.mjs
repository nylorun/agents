// Writes the Harness API's JSON Schema document next to the compiled module (R4.5, Q4).
import { writeFileSync } from "node:fs";
import { harnessApiJsonSchema } from "../dist/harness-api/json-schema.js";

const file = new URL("../dist/harness-api/harness-api.schema.json", import.meta.url);
writeFileSync(file, `${JSON.stringify(harnessApiJsonSchema(), null, 2)}\n`);
