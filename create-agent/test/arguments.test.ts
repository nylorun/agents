import { describe, expect, it } from "vitest";
import { NO_OPEN_IGNORED, NO_STUDIO_DEPRECATED, parse } from "../dist/arguments.js";

describe("creator arguments", () => {
  it("installs by default, including with --yes", () => {
    expect(parse(["demo", "--yes"])).toMatchObject({ yes: true, notes: [] });
  });
  it("accepts and ignores the deprecated --no-studio with a note", () => {
    const options = parse(["demo", "--no-studio"]);
    expect(options).toMatchObject({ notes: [NO_STUDIO_DEPRECATED] });
    expect(options).not.toHaveProperty("studio");
  });
  it("accepts and ignores --no-open: the creator opens no browser", () => {
    expect(parse(["demo", "--no-open"])).toMatchObject({ notes: [NO_OPEN_IGNORED] });
    expect(parse(["demo", "--no-open"])).not.toHaveProperty("open");
  });
  it("rejects unknown options", () => {
    expect(() => parse(["demo", "--skip-config"])).toThrow("Usage:");
    expect(() => parse(["demo", "--studio"])).toThrow("Usage:");
  });
});
