import { describe, expect, it } from "vitest";
import { NO_STUDIO_DEPRECATED, parse } from "../dist/arguments.js";

describe("creator arguments", () => {
  it("installs by default, including with --yes", () => {
    expect(parse(["demo", "--yes"])).toMatchObject({ yes: true, notes: [] });
  });
  it("accepts and ignores the deprecated --no-studio with a note", () => {
    const options = parse(["demo", "--no-studio"]);
    expect(options).toMatchObject({ open: true, notes: [NO_STUDIO_DEPRECATED] });
    expect(options).not.toHaveProperty("studio");
  });
  it("opens Studio by default and supports suppressing the browser", () => {
    expect(parse(["demo"])).toMatchObject({ open: true });
    expect(parse(["demo", "--no-open"])).toMatchObject({ open: false });
  });
  it("rejects unknown options", () => {
    expect(() => parse(["demo", "--skip-config"])).toThrow("Usage:");
    expect(() => parse(["demo", "--studio"])).toThrow("Usage:");
  });
});
