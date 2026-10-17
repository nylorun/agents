import type { ModelCandidate, ModelOutputBlock, ModelToolCall } from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import { createId } from "../../utils/ids.js";
import { copyJson } from "@nylorun/core/define";
import { memoryAliasOf } from "@nylorun/core/contracts";

/**
 * A call to `memory.<command>` or `memory/<command>` when the model was offered `memory` (track
 * T5, E-P1): the `memory` tool with that command, as the conversation records it from then on.
 * A call whose own `command` disagrees with its name stays as it was, and fails as unknown.
 */
export function memoryAliasCall(
  name: string,
  args: JsonObject,
  offered: ReadonlySet<string>,
): { name: string; args: JsonObject } | undefined {
  if (offered.has(name) || !offered.has("memory")) return undefined;
  const command = memoryAliasOf(name);
  if (!command || (args.command !== undefined && args.command !== command)) return undefined;
  return { name: "memory", args: { command, ...args } };
}

export interface CanonicalCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly missingId: boolean;
  readonly duplicateId?: string;
}

export function canonicalizeCalls(
  calls: readonly { readonly id?: string; readonly name?: string; readonly args: JsonObject }[],
  offered: ReadonlySet<string> = new Set(),
): readonly CanonicalCall[] {
  const idCounts = new Map<string, number>();
  for (const call of calls) {
    if (typeof call.id === "string" && call.id)
      idCounts.set(call.id, (idCounts.get(call.id) ?? 0) + 1);
  }
  return Object.freeze(
    calls.map((call) => {
      const hasId = typeof call.id === "string" && call.id.length > 0;
      const duplicateId = hasId && (idCounts.get(call.id) ?? 0) > 1 ? call.id : undefined;
      const name = typeof call.name === "string" && call.name ? call.name : "unknown";
      const alias = memoryAliasCall(name, call.args, offered);
      return Object.freeze({
        id: hasId && !duplicateId ? call.id : createId("call"),
        name: alias?.name ?? name,
        args: alias?.args ?? call.args,
        missingId: !hasId,
        ...(duplicateId ? { duplicateId } : {}),
      });
    }),
  );
}

export function canonicalizeOutput(
  output: readonly ModelOutputBlock[],
  offered?: ReadonlySet<string>,
): {
  readonly output: readonly ModelOutputBlock[];
  readonly calls: readonly CanonicalCall[];
} {
  const calls = canonicalizeCalls(
    output.flatMap((block) => (block.type === "tool-call" ? [block] : [])),
    offered,
  );
  let index = 0;
  return {
    output: Object.freeze(
      output.map((block) => {
        if (block.type !== "tool-call") return block;
        const call = calls[index++]!;
        return Object.freeze({
          type: "tool-call" as const,
          id: call.id,
          name: call.name,
          args: call.args,
          ...(block.providerMetadata === undefined
            ? {}
            : { providerMetadata: block.providerMetadata }),
          ...(block.raw === undefined ? {} : { raw: block.raw }),
        });
      }),
    ),
    calls,
  };
}

export function candidateFromCanonical(
  candidate: ModelCandidate,
  output: readonly ModelOutputBlock[],
): ModelCandidate {
  return Object.freeze({
    output,
    ...(candidate.finishReason === undefined ? {} : { finishReason: candidate.finishReason }),
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
    ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
  });
}
