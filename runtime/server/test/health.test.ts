import { expect, it } from "vitest";
import { HealthResponseSchema } from "@nylorun/core/contracts";
import { RUNTIME_VERSION } from "../src/version.js";

// HealthResponseSchema no longer accepts scopeId; the Host serves /health.
it.todo("reports the runtime version and scope without authentication");

it.todo(
  "keeps the scope identifier stable per database and free of filesystem paths",
);

it.todo("still parses a health payload from a Runtime that predates these fields");

void HealthResponseSchema;
void RUNTIME_VERSION;
void expect;
