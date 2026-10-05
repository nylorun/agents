import { Agent } from "@nylorun/agents";
import { lookupOrder } from "../shared/orders.js";

/**
 * The agent the AG-UI example (`src/ag-ui/`) puts in front of a web app's users: the release
 * assistant's order lookup, asking the person before each call. Its `lookup_order` is an HTTP
 * tool the app serves itself at `<url>/lookup_order`. Not in the release registry: the AG-UI
 * app saves it with the URL it listens at.
 */
export function supportAgent(url: string) {
  return Agent({ id: "support", name: "Support desk" })
    .instructions("Help with orders. Always use lookup_order for order questions. Remember conversation context.")
    .tools(lookupOrder({ url, approval: "always" }))
    .build();
}
