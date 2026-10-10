import { HarnessError, type HarnessErrorCode } from "@nylorun/core/define";

export interface SlotOwner {
  readonly middlewareId: string;
  readonly middlewareOrder: number;
  readonly slot: string;
  readonly order: number;
}

export interface SlotDeclaration<Value> {
  readonly owner: SlotOwner;
  readonly value: Value;
  readonly reason?: string;
}

/**
 * Shared per-step slot store. Declarations are discarded with the draft that owns this instance.
 * Configuration and context supply their typed values and snapshot them after this assembler has
 * applied ownership, replacement, and canonical ordering.
 */
export class SlotDraft<Value> {
  readonly #slots = new Map<string, SlotDeclaration<Value>>();

  set(input: {
    readonly middlewareId: string;
    readonly middlewareOrder: number;
    readonly slot: string;
    readonly value: Value;
    readonly order?: number;
    readonly reason?: string;
    readonly invalidSlot: HarnessErrorCode;
    readonly invalidOrder: HarnessErrorCode;
    readonly invalidReason: HarnessErrorCode;
    readonly label: string;
  }): void {
    checkedSlot(input.slot, input.invalidSlot, input.label);
    const base = slotOwner(input.middlewareId, input.middlewareOrder, input.slot);
    const key = slotKey(base);
    const prior = this.#slots.get(key);
    const owner = withOrder(base, input.order, prior?.owner.order, input.invalidOrder, input.label);
    this.#slots.set(
      key,
      Object.freeze({
        owner,
        value: input.value,
        ...(input.reason === undefined
          ? {}
          : { reason: checkedReason(input.reason, input.invalidReason, input.label) }),
      }),
    );
  }

  values(): readonly SlotDeclaration<Value>[] {
    return Object.freeze(
      [...this.#slots.values()].sort((left, right) => compareSlotOwners(left.owner, right.owner)),
    );
  }
}

export function slotOwner(middlewareId: string, middlewareOrder: number, slot: string): SlotOwner {
  return Object.freeze({ middlewareId, middlewareOrder, slot, order: 0 });
}

export function slotKey(value: SlotOwner): string {
  return `${value.middlewareId}\u0000${value.slot}`;
}

export function checkedSlot(value: string, code: HarnessErrorCode, label: string): void {
  if (typeof value !== "string" || value.length === 0)
    throw new HarnessError(code, `${label} slot must be a non-empty string`);
}

export function checkedReason(value: string, code: HarnessErrorCode, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new HarnessError(code, `${label} mutation reason must be a non-empty string`);
  return value;
}

export function withOrder(
  owner: SlotOwner,
  requested: number | undefined,
  previousOrder: number | undefined,
  code: HarnessErrorCode,
  label: string,
): SlotOwner {
  const order = requested ?? previousOrder ?? 0;
  if (!Number.isFinite(order))
    throw new HarnessError(code, `${label} order must be a finite number`);
  return Object.freeze({ ...owner, order });
}

export function compareSlotOwners(left: SlotOwner, right: SlotOwner): number {
  return (
    left.order - right.order ||
    left.middlewareOrder - right.middlewareOrder ||
    left.slot.localeCompare(right.slot)
  );
}
