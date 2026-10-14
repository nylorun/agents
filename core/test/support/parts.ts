import type { PartDeclaration } from "../../src/define.js";

/** Adds a raw definition part, as the SDK's `.skills()` and `.plugin()` do. */
export function addPart<B>(builder: B, declaration: PartDeclaration): B {
  return (builder as unknown as { withPart(d: PartDeclaration, method: string): B }).withPart(
    declaration,
    "part()"
  );
}
