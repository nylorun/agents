import { run, bindingFromAgent } from "@nylorun/harness/run";
const runAgent = (agent: Parameters<typeof bindingFromAgent>[0], options: Omit<Parameters<typeof run>[0], "binding">) => run({ binding: bindingFromAgent(agent), ...options });
import { afterEach, expect, it, vi } from "vitest";
import { Agent, tool } from "@nylorun/core/define";
import { piModel } from "@nylorun/runtime/node";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("completes a signed Gemini tool conversation across the published engine/runtime interfaces", async () => {
  vi.stubEnv("GEMINI_API_KEY", "fixture-key");
  const readHostModel = () => ({
    provider: "google",
    model: "gemini-flash-latest",
    authType: "api_key" as const,
    credential: { type: "api_key" as const, key: "fixture-key" },
  });
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      const body = JSON.parse(
        String(
          options?.body ??
            (url instanceof Request ? await url.text() : undefined),
        ),
      );
      requests++;
      if (requests > 1) {
        const modelParts = body.contents.find(
          (message: { role: string }) => message.role === "model",
        )?.parts;
        if (
          !modelParts?.some(
            (part: { thoughtSignature?: string }) =>
              part.thoughtSignature === "c2lnbmF0dXJl",
          )
        ) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Function call is missing a thought_signature",
                code: 400,
              },
            }),
            { status: 400 },
          );
        }
        expect(JSON.stringify(body.contents)).toContain("sum");
        expect(JSON.stringify(body.contents)).toContain("26");
      }
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: requests === 1 ? [{ functionCall: { name: "add_numbers", args: { a: 19, b: 7 } }, thoughtSignature: "c2lnbmF0dXJl" }] : [{ text: "26" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const agent = Agent({ id: "assistant", name: "Assistant" })
    .use({
      id: "arithmetic",
      tools: [
        tool({
          name: "add_numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => ({
            kind: "completed",
            output: { sum: a + b },
          }),
        }),
      ],
    })
    .build();
  const result = await runAgent(agent, {
    input: "Add 19 and 7",
    onModelCall: piModel({ readHostModel }),
  });
  expect(result).toMatchObject({ status: "completed", output: "26" });
  expect(requests).toBe(2);
});
