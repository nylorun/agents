import type {
  ContextContributor,
  ContextMutationOptions,
  ContextSnapshot,
} from "@nylorun/core/define";
import type { ContextItem, JsonValue } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";
import { SlotDraft, type SlotOwner } from "./slot-assembly.js";

const CONTEXT_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Per-step model-visible context supplied explicitly by middleware. */
export class ContextDraft {
  #slots = new SlotDraft<readonly ContextItem[]>();

  set(
    middlewareId: string,
    middlewareOrder: number,
    slot: string,
    items: readonly ContextItem[],
    options?: ContextMutationOptions,
  ): void {
    if (!Array.isArray(items))
      throw new HarnessError("context.invalid-item", "Runtime context items must be an array");
    this.#slots.set({
      middlewareId,
      middlewareOrder,
      slot,
      value: Object.freeze(items.map(normalizeItem)),
      order: options?.order,
      reason: options?.reason,
      invalidSlot: "context.invalid-slot",
      invalidOrder: "context.invalid-order",
      invalidReason: "context.invalid-reason",
      label: "Runtime context",
    });
  }

  snapshot(): ContextSnapshot {
    const slots = this.#slots.values();
    const items = Object.freeze(slots.flatMap((slot) => slot.value));
    const contributors = Object.freeze(slots.map((slot) => contributor(slot.owner, slot.reason)));
    return Object.freeze({ items, contributors });
  }
}

function normalizeItem(item: ContextItem): ContextItem {
  if (!item || typeof item !== "object")
    throw new HarnessError("context.invalid-item", "Runtime context items must be objects");
  if (item.type !== undefined && (typeof item.type !== "string" || !CONTEXT_TYPE.test(item.type)))
    throw new HarnessError(
      "context.invalid-item-type",
      "Runtime context item type must match [A-Za-z][A-Za-z0-9_-]{0,63}",
    );
  return Object.freeze({
    ...(item.type === undefined ? {} : { type: item.type }),
    value: copyJson(item.value) as JsonValue,
  });
}

function contributor(owner: SlotOwner, reason?: string): ContextContributor {
  return Object.freeze({
    middlewareId: owner.middlewareId,
    slot: owner.slot,
    order: owner.order,
    ...(reason === undefined ? {} : { reason }),
  });
}
