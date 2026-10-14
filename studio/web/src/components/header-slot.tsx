import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Slots = { start: HTMLElement | null; end: HTMLElement | null };

/** The page header's two slots: after the title, and before the header's own actions. */
export const HeaderSlotContext = createContext<Slots>({ start: null, end: null });

/**
 * Renders a view's own details in the page header, so a view such as a
 * session needs no second bar of its own. Renders nothing outside a header.
 */
export function HeaderSlot({
  side,
  children,
}: Readonly<{ side: keyof Slots; children: ReactNode }>) {
  const target = useContext(HeaderSlotContext)[side];
  return target ? createPortal(children, target) : null;
}
