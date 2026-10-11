import { Agent } from "@nylorun/agents";
import type { ToolRule } from "@nylorun/core/contracts";
import { lookupOrder } from "../shared/orders.js";

/**
 * The agent the AG-UI example (`src/ag-ui/`) puts in front of a web app's users: the release
 * assistant's order lookup. Its `lookup_order` is an HTTP tool the app serves itself at
 * `<url>/lookup_order`. Not in the release registry: the AG-UI app saves it with the URL it
 * listens at.
 */
export function supportAgent(url: string) {
  return Agent({ id: "support", name: "Support desk" })
    .instructions("Help with orders. Always use lookup_order for order questions. Remember conversation context.")
    .tools(lookupOrder({ url }))
    .build();
}

/**
 * The Tenant's tool policy rule that asks the person before each of the support desk's order
 * lookups (`PUT /v1/tenant/tool-policy`, a Management API setting the operator owns).
 */
export const SUPPORT_APPROVAL: ToolRule = {
  effect: "ask",
  tool: "lookup_order",
  agent: "support",
  reason: "The support desk asks before each order lookup",
};
