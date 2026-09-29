import { Agent, tool } from "@nylorun/agents";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookup_order",
  description: "Look up a sample order by ID. Try demo-123.",
  input: z.object({ orderId: z.string() }),
  output: z.object({ orderId: z.string(), status: z.string() }),
  async run({ orderId }) {
    return { orderId, status: orderId === "demo-123" ? "shipped" : "not found" };
  },
});

export const assistant = Agent({ id: "assistant", name: "Order assistant" })
  .instructions("Help with orders. Always use lookup_order for order questions. Remember conversation context.")
  .tools(lookupOrder)
  .build();
