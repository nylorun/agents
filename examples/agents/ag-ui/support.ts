import { Agent, tool } from "@nylorun/agents";
import { z } from "zod";

/** The order lookup from the release assistant, asking the person before it runs. */
const lookupOrder = tool({
  name: "lookup_order",
  description: "Look up a sample order by ID. Try demo-123.",
  input: z.object({ orderId: z.string() }),
  output: z.object({ orderId: z.string(), status: z.string() }),
  approval: ({ orderId }) => `Look up order ${orderId}?`,
  async run({ orderId }) {
    return { orderId, status: orderId === "demo-123" ? "shipped" : "not found" };
  },
});

/**
 * The agent the AG-UI example (`src/ag-ui/`) serves to a web app's users. Not in the release
 * registry: the AG-UI server serves its own Action endpoint for it.
 */
export const support = Agent({
  id: "support",
  name: "Support desk",
  instructions: "Help with orders. Always use lookup_order for order questions. Remember conversation context.",
  tools: [lookupOrder],
}).build();
