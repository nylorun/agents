import { createClient, type AgentsClient } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import { createAdmin, type ManagementClient } from "@nylorun/admin";
import { SUPPORT_APPROVAL, supportAgent } from "../../agents/ag-ui/support.js";
import { lookupOrderCode } from "../../agents/shared/orders.js";
import { toolsService } from "../../agents/shared/tools/service.js";
import { userFromCookie } from "./demo-auth.js";

/** Where this app answers the support agent's tool calls; everything else is the AG-UI endpoint. */
export const TOOLS_PATH = "/lookup_order";

/**
 * A web backend's whole Nylorun integration: the AG-UI endpoint its browser talks to, and the
 * order lookup the Runtime calls for the agent's `lookup_order` (an HTTP tool; the Runtime runs
 * no code of this app). The application key stays here; the AG-UI handler calls the Runtime as
 * each signed-in person, so people only reach their own threads. Without `client`, both resolve
 * the Runtime from the environment or the Project link. `admin` (a management key, which the
 * operator holds) sets the Tenant's tool policy so each lookup waits for the person; without it,
 * `createAdmin()` finds the key the same way.
 */
export function createSupportApp(options: { client?: AgentsClient; admin?: ManagementClient } = {}) {
  const { client } = options;
  const tools = toolsService([lookupOrderCode]);
  const handler = createAgUiHandler({
    basePath: "/api/agui",
    agents: ["support"],
    ...(client ? { client } : {}),
    subject: (request) => userFromCookie(request)?.id,
  });
  const fetch = (request: Request) =>
    new URL(request.url).pathname === TOOLS_PATH ? tools(request) : handler.fetch(request);
  return {
    handler,
    listener: toNodeListener({ fetch }),
    /**
     * Saves the support agent's manifest, whose tool the Runtime reaches at `origin` +
     * `TOOLS_PATH`, makes the Agent `support` the endpoint runs (kind `none`: no sandbox, so one
     * Agent serves every person), and adds the rule that asks the person before each lookup to the
     * Tenant's tool policy. The Agent tracks the manifest: a later save moves it to the new version.
     */
    save: async (origin: string) => {
      const runtime = client ?? (await createClient());
      const saved = await runtime.agentManifests.save({ agent: supportAgent(origin) });
      await runtime.agents.put("support", { manifest: "support" });
      const admin = options.admin ?? createAdmin();
      const { rules } = await admin.toolPolicy.get();
      const others = rules.filter((rule) => !(rule.agent === "support" && rule.tool === "lookup_order"));
      await admin.toolPolicy.put({ rules: [...others, SUPPORT_APPROVAL] });
      return saved;
    },
  };
}
