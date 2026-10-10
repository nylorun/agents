import type { ModelCandidate, ModelOutputBlock, ModelToolCall } from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import { createId } from "../../utils/ids.js";
import { copyJson } from "@nylorun/core/define";

export interface CanonicalCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly missingId: boolean;
  readonly duplicateId?: string;
}

export function canonicalizeCalls(
  calls: readonly { readonly id?: string; readonly name?: string; readonly args: JsonObject }[],
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
      return Object.freeze({
        id: hasId && !duplicateId ? call.id : createId("call"),
        name: typeof call.name === "string" && call.name ? call.name : "unknown",
        args: call.args,
        missingId: !hasId,
        ...(duplicateId ? { duplicateId } : {}),
      });
    }),
  );
}

export function callsFromCanonical(calls: readonly CanonicalCall[]): readonly ModelToolCall[] {
  return Object.freeze(
    calls.map((call) =>
      Object.freeze({
        id: call.id,
        name: call.name,
        args: call.args,
      }),
    ),
  );
}

export function canonicalizeOutput(output: readonly ModelOutputBlock[]): {
  readonly output: readonly ModelOutputBlock[];
  readonly calls: readonly CanonicalCall[];
} {
  const calls = canonicalizeCalls(
    output.flatMap((block) => (block.type === "tool-call" ? [block] : [])),
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

export function identityKey(name: string, args: unknown): string {
  try {
    return `${name}:${JSON.stringify(copyJson(args as never))}`;
  } catch {
    return `${name}:${String(args)}`;
  }
}
