import { Agent } from "@nylorun/agents";
import { lookupOrder } from "../shared/orders.js";

/**
 * `lookup_order` is an HTTP tool: the Runtime calls the examples' tools service
 * (`src/tools/server.ts`, which root `npm run dev` starts) and runs no code of this project.
 */
export const assistant = Agent({ id: "assistant", name: "Order assistant" })
  .instructions("Help with orders. Always use lookup_order for order questions. Remember conversation context.")
  .tools(lookupOrder())
  .build();
