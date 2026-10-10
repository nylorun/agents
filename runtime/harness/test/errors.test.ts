import { describe, expect, it } from "vitest";
import { HarnessError, isHarnessError } from "@nylorun/core/define";

describe("HarnessError", () => {
  it("exposes an immutable code, safe details, and foreign cause", () => {
    const cause = new Error("provider down");
    const error = new HarnessError(
      "configuration.duplicate-tool-name",
      "internal wording can change",
      {
        cause,
        details: { toolName: "echo" },
      },
    );

    expect(isHarnessError(error)).toBe(true);
    expect(isHarnessError(cause)).toBe(false);
    expect(error.code).toBe("configuration.duplicate-tool-name");
    expect(error.message).toBe("internal wording can change");
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ toolName: "echo" });
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
