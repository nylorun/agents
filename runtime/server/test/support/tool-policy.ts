/**
 * The Tenant's tool policy for a test Tenant (R5 step 2): the rules the Runtime applies to every
 * MCP and HTTP tool call, set on the Management API as an operator would.
 */
import type { ToolRule } from "@nylorun/core/contracts";

export async function setToolPolicy(
  runtime: { url: string; managementHeaders(): Record<string, string> },
  rules: readonly ToolRule[],
): Promise<void> {
  const response = await fetch(`${runtime.url}/v1/tenant/tool-policy`, {
    method: "PUT",
    headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  if (!response.ok) throw new Error(`Setting the tool policy failed: ${response.status} ${await response.text()}`);
}
