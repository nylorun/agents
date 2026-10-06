import { tool } from "@nylorun/agents/define";
import { z } from "zod";
import { CodexWorkspace } from "./codex.js";

export function codexTools(workspaces: Map<string, CodexWorkspace>) {
  const workspace = (sessionId: string): CodexWorkspace => {
    const found = workspaces.get(sessionId);
    if (found) return found;
    const created = new CodexWorkspace();
    workspaces.set(sessionId, created);
    return created;
  };

  return {
    id: "codex",
    instructions: [
      "codex_exec runs the host Codex CLI in an isolated temporary workspace. Ask for approval before launching it.",
      "Each new workspace already contains hello.js with an exported hello(name = 'world') function. Preserve it when adding another function. The task argument is a plain-language instruction for Codex, not JavaScript or a shell script.",
    ],
    tools: [
      tool({
        name: "codex_exec",
        description:
          "Give plain-language editing instructions to the host-installed Codex CLI after approval. Its temporary workspace is already seeded with hello.js.",
        inputSchema: z.object({
          task: z
            .string()
            .min(1)
            .max(4_000)
            .describe(
              "Plain-language instructions describing the requested edit and verification in the temporary workspace.",
            ),
        }),
        approval: ({ task }) => `Approve codex_exec?\n\n${JSON.stringify({ task })}`,
        async execute({ task }, context) {
          if (context.resume?.approved === false) {
            return {
              kind: "denied" as const,
              reason: "The user declined the Codex run.",
            };
          }
          try {
            return {
              kind: "completed" as const,
              output: await workspace(((context.info as { sessionId?: string } | undefined)?.sessionId ?? context.executionId)).exec(
                task,
                context.signal,
              ),
            };
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "codex.unavailable",
              message:
                error instanceof Error
                  ? error.message
                  : "Codex CLI unavailable.",
            };
          }
        },
      }),
    ],
  } as const;
}
