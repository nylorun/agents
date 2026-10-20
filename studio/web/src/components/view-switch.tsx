import type { ReactNode } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";

/**
 * A view switch inside a tab or a pane: a segmented control, the active view raised. Use it in a
 * `Tabs.Root` whose contents are the views; DESIGN.md has no tabs inside a tab.
 */
export function ViewSwitch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b px-4">
      <TabsPrimitive.List aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
        {children}
      </TabsPrimitive.List>
    </div>
  );
}

/** One view of a `ViewSwitch`. */
export function ViewOption({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="rounded-md px-3 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}
