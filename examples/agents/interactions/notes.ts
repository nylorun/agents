import { tool } from "@nylorun/agents/define";
import { z } from "zod";
import type { JsonlNotes } from "./notes-store.js";

export function notes(notes: JsonlNotes) {
  return {
    id: "notes",
    instructions: [
      "Use write_note only when the user asks to save a note. A human approval is required before the write.",
    ],
    tools: [
      tool({
        name: "read_notes",
        description: "Read the most recent locally stored notes.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(20).default(5),
        }),
        async execute({ limit }) {
          return {
            kind: "completed" as const,
            output: { notes: await notes.recent(limit) },
          };
        },
      }),
      tool({
        name: "write_note",
        description: "Write a local JSONL note after the user approves.",
        inputSchema: z.object({ text: z.string().min(1).max(2_000) }),
        // Services and tools do not self-authorize writes: each call waits for a person.
        approval: ({ text }) => `Approve write_note?\n\n${JSON.stringify({ text })}`,
        async execute({ text }, context) {
          if (context.resume?.approved === false) {
            return {
              kind: "denied" as const,
              reason: "The user declined the note write.",
            };
          }
          return {
            kind: "completed" as const,
            output: { note: await notes.write(text) },
          };
        },
      }),
    ],
  } as const;
}
