import type { CapabilityInput } from "../../src/define.js";

/** Adds a raw definition part, as the SDK's `.skills()` and `.plugin()` do. */
export function addPart<B>(builder: B, declaration: CapabilityInput): B {
  return (builder as unknown as { withPart(d: CapabilityInput, method: string): B }).withPart(
    declaration,
    "part()"
  );
}
