import { Agent } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Switch: pick one case by a key your code computes from the input.
 * Design: docs/design/agent/flow-agents.md
 */
const triager = Agent({
  id: "triager",
  name: "Triager",
  description: "Classifies a support ticket.",
})
  .instructions("Classify the ticket. Return kind and a short summary.")
  .output(
    z.object({
      kind: z.enum(["bug", "billing", "other"]),
      summary: z.string(),
    }),
  );

const bugAgent = Agent({
  id: "bug-agent",
  name: "Bug agent",
  description: "Handles bug tickets.",
}).instructions("Help with the bug. Be concrete.");

const billingAgent = Agent({
  id: "billing-agent",
  name: "Billing agent",
  description: "Handles billing tickets.",
}).instructions("Help with billing. Be precise about amounts and dates.");

const generalAgent = Agent({
  id: "general-agent",
  name: "General agent",
  description: "Handles other tickets.",
}).instructions("Help with the ticket.");

export const support = Agent({
  id: "support",
  name: "Support",
  description: "Triages a ticket and routes it to the agent for its kind.",
})
  .step(triager)
  .switch(
    { bug: bugAgent, billing: billingAgent, default: generalAgent },
    { on: ({ input }) => input.kind, id: "route" },
  );
