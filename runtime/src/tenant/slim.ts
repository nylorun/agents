import type { Tx } from "../store/types.js";

/**
 * Slim the completed model effects of a turn that ended (Model Calls §9): drop the prompt
 * and the answer, which the transcript already holds, and keep the identity and status.
 * Replay only ever reads the effects of a running segment. Tool, flow and uncertain rows
 * are never touched: completed actions return their receipts, and status lists uncertain work.
 */
export async function slimModelEffects(
  t: Tx,
  sessionId: string,
  turnId: string | null
): Promise<void> {
  if (!turnId) return;
  for (const effect of await t.effectsForTurn<any>(sessionId, turnId, ["completed"])) {
    if (effect.request?.kind !== "model" || effect.slimmed) continue;
    const { input: _input, ...request } = effect.request;
    await t.put("effects", request.effectId, {
      ...effect,
      request,
      outcome: {},
      slimmed: true,
    });
  }
}
