import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import manifest from "../package.json";

describe("public API", () => {
  it("exports the documented construction helpers and no provider adapters", () => {
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        "run",
        "runDurable",
        "createRunState",
        "createDurableCheckpoint",
        "createExecutionState",
        "checkCompatibility",
      ]),
    );
    expect(api).not.toHaveProperty("Agent");
    expect(api).not.toHaveProperty("tool");
    expect(api).not.toHaveProperty("bindAgent");
    expect(api).not.toHaveProperty("BuiltAgent");
    expect(api).not.toHaveProperty("defineToolFamily");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).not.toHaveProperty("./model/adapters");
    expect(manifest.exports).toHaveProperty("./run");
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./api",
      "./compatibility",
      "./run",
    ]);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@nylorun/core"]);
    expect(manifest.dependencies?.["@nylorun/core"]).toMatch(/^\d+\.\d+\.\d+(?:-beta(?:\.\d+)?)?$/);
  });

  it("exports the Harness API client from ./api", async () => {
    const harnessApi = await import("../src/api/index.js");
    expect(Object.keys(harnessApi).sort()).toEqual([
      "ABORT_MESSAGES",
      "RunAbort",
      "TranscriptCache",
      "apiHost",
      "createHarness",
      "runAbortKind",
      "runTurn",
    ]);
  });
});
