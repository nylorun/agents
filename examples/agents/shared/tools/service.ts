import { http, type ToolDefinition } from "@nylorun/agents";

/**
 * The examples' tools service: the Runtime runs agents from their manifests alone, so a tool's
 * code runs here and the agent describes it with `http()`. The Runtime POSTs the tool's input as
 * JSON to `<TOOLS_URL>/<tool name>` and gives the model the JSON answer; any other status is a
 * failed call whose body the model reads. `src/tools/server.ts` serves it (root `npm run dev`
 * starts it).
 */
export const TOOLS_PORT = Number(process.env.TOOLS_PORT ?? 3001);
/**
 * Where the Runtime reaches the service. On a local Tenant the Runtime runs in Docker and
 * `localhost` means this machine; elsewhere set TOOLS_URL to the service's public URL.
 */
export const TOOLS_URL = (process.env.TOOLS_URL ?? `http://localhost:${TOOLS_PORT}`).replace(/\/$/, "");

/** An `http()` tool that calls `tool`'s code on the service at `base`. */
export function serviced(tool: ToolDefinition<any, any, any>, base = TOOLS_URL): ToolDefinition {
  return http({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input: tool.inputSchema as never,
    ...(tool.outputSchema === undefined ? {} : { output: tool.outputSchema as never }),
    url: `${base}/${encodeURIComponent(tool.name)}`,
  }) as ToolDefinition;
}

/** A web-standard handler that runs `tools` (code tools) for the Runtime: `POST /<name>`. */
export function toolsService(tools: readonly ToolDefinition<any, any, any>[]) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return async (request: Request): Promise<Response> => {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const tool = byName.get(name);
    const run = tool?.execute ?? tool?.run;
    if (request.method !== "POST" || !run) return new Response(`No tool ${name}`, { status: 404 });
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return new Response("The input is not JSON", { status: 400 });
    }
    try {
      // These tools read nothing from their context.
      const outcome = (await run(input as never, { signal: request.signal } as never)) as unknown;
      if (outcome && typeof outcome === "object" && "kind" in outcome) {
        const result = outcome as { kind: string; output?: unknown; message?: string };
        if (result.kind === "completed") return Response.json(result.output ?? null);
        return new Response(result.message ?? result.kind, { status: 422 });
      }
      return Response.json(outcome ?? null);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  };
}
