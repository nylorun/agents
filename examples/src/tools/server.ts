import { createServer } from "node:http";
import { toNodeListener } from "@nylorun/agents/ag-ui";
import { lookupOrderCode } from "../../agents/shared/orders.js";
import { catalog } from "../../agents/shared/tools/index.js";
import { TOOLS_PORT, toolsService } from "../../agents/shared/tools/service.js";

// The examples' tools service: the code behind the agents' `http()` tools (lookup_order and the
// tools catalog). It listens on every interface: a local Tenant's Runtime runs in Docker and
// reaches this machine's `localhost` through the Docker host.
const tools = [lookupOrderCode, ...(await catalog())];
const server = createServer(toNodeListener({ fetch: toolsService(tools) }));
server.listen(TOOLS_PORT, () =>
  console.log(`Tools service on http://localhost:${TOOLS_PORT}: ${tools.map((tool) => tool.name).join(", ")}`),
);
