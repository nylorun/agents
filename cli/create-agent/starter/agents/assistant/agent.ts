import { Agent } from "@nylorun/agents";

// To give the assistant a tool, describe an HTTP service the Runtime calls (it runs no code
// of yours during a session), or serve it from a remote MCP server:
//
//   import { http } from "@nylorun/agents";
//   import { z } from "zod";
//
//   const lookupOrder = http({
//     name: "lookup_order",
//     description: "Look up an order by ID.",
//     input: z.object({ orderId: z.string() }),
//     url: "https://orders.example.com/lookup",
//   });
//
// and add `.tools(lookupOrder)` below.

export const assistant = Agent({ id: "assistant", name: "Assistant" })
  .instructions("You are a helpful assistant. Answer concisely and remember conversation context.")
  .build();
