import { expect, it } from "vitest";
import { Agent, type BuiltAgent, type ModelAdapter } from "@nylorun/core/define";
import type { RuntimeAgent } from "@nylorun/runtime";
import { piModel } from "@nylorun/runtime/node";

// These assignments must compile without assertions; Runtime depends on canonical Harness types.
const adapter: ModelAdapter = piModel();
const built: BuiltAgent = Agent({ id: "configured", name: "Configured" }).build();
const portable: RuntimeAgent = built;

it("accepts a built agent and the pi-ai adapter through canonical Harness types", () => {
  expect(portable.manifest.id).toBe("configured");
  expect(typeof adapter).toBe("function");
});
