import { tool } from "@nylorun/agents/define";
import { http } from "@nylorun/agents";
import { z } from "zod";
import { TOOLS_URL } from "./tools/service.js";

const input = z.object({ orderId: z.string() });
const output = z.object({ orderId: z.string(), status: z.string() });
const description = "Look up a sample order by ID. Try demo-123.";

/** The order lookup's code, which the tools service runs (`POST /lookup_order`). */
export const lookupOrderCode = tool({
  name: "lookup_order",
  description,
  input,
  output,
  async run({ orderId }) {
    return { orderId, status: orderId === "demo-123" ? "shipped" : "not found" };
  },
});

/**
 * The tool an agent declares: the Runtime POSTs `{ orderId }` to `<url>/lookup_order` (default
 * TOOLS_URL, the tools service). `approval: "always"` makes each call wait for the person.
 */
export function lookupOrder(options: { url?: string; approval?: "always" | "never" } = {}) {
  return http({
    name: "lookup_order",
    description,
    input,
    output,
    url: `${(options.url ?? TOOLS_URL).replace(/\/$/, "")}/lookup_order`,
    ...(options.approval ? { approval: options.approval } : {}),
  });
}
