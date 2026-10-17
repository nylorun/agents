import type { ReactNode } from "react";
import { Check, ChevronDown, MoreHorizontal, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * The parts every table on an Agent's page is made of: one toolbar (search, filter menus, a
 * count, a ⋯ menu), compact single-line rows that end in a ⋯ menu, and a panel on the right
 * for one row's details. Nothing here reads data.
 */

/** The strip above a table: full width, its controls on one line that wraps. */
export function TableToolbar({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-3">{children}</div>;
}

/** What the toolbar counts, at its right end. */
export function ToolbarCount({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="ml-auto truncate text-sm text-muted-foreground">{children}</span>;
}

export function SearchBox({
  label,
  value,
  onChange,
}: Readonly<{ label: string; value: string; onChange: (value: string) => void }>) {
  return (
    <label className="flex h-8 min-w-40 flex-[0_1_16rem] items-center gap-1.5 rounded-md border px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
      <Search className="size-3.5 shrink-0" aria-hidden />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

export type FilterOption<T extends string> = { value: T; label: string };

/** One filter: a menu of options, the first of which means "any". */
export function FilterMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string;
  value: T;
  options: readonly FilterOption<T>[];
  onChange: (value: T) => void;
}>) {
  const current = options.find((option) => option.value === value) ?? options[0]!;
  const active = current.value !== options[0]!.value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Filter by ${label.toLowerCase()}`}
          className={cn("gap-1.5 font-normal", active && "border-foreground/40 bg-muted")}
        >
          <span className="text-muted-foreground">{label}</span>
          {current.label}
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={option.value === current.value}
            onSelect={() => onChange(option.value)}
          >
            <Check className={cn("size-3.5", option.value === current.value ? "opacity-100" : "opacity-0")} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type MenuAction = {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Draws a line above it: the destructive ones come last, set apart. */
  separated?: boolean;
};

/** A ⋯ menu: a row's actions, a panel's, or a toolbar's. */
export function ActionMenu({
  label,
  actions,
  bordered = false,
}: Readonly<{ label: string; actions: readonly MenuAction[]; bordered?: boolean }>) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={bordered ? "outline" : "ghost"}
          size="icon-sm"
          aria-label={label}
          title={label}
          className={bordered ? undefined : "text-muted-foreground"}
          // A row opens its panel on a click: the menu is not that click.
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48" onClick={(event) => event.stopPropagation()}>
        {actions.map((action) => (
          <div key={action.label} className="contents">
            {action.separated ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={action.destructive ? "destructive" : "default"}
              disabled={action.disabled}
              onSelect={action.onSelect}
            >
              {action.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact, single-line rows: long text is cut with an ellipsis, never wrapped. */
export const tableClass = "w-full table-fixed border-collapse text-sm";
export const headClass =
  "h-9 border-b px-3 text-left align-middle text-[13px] font-medium whitespace-nowrap text-muted-foreground first:pl-4";
export const cellClass = "h-10 truncate border-b px-3 align-middle whitespace-nowrap first:pl-4";
export const rowClass = "hover:bg-muted/50 data-[state=selected]:bg-muted";
/** The last column: the row's ⋯ menu. */
export const menuCellClass = "w-12 border-b px-2 text-right align-middle";

/** A table's frame: the full width, and a sideways scroll when it is narrower than its columns. */
export function TableFrame({ children, minWidth }: Readonly<{ children: ReactNode; minWidth?: number }>) {
  return (
    <div className="overflow-x-auto">
      <table className={tableClass} style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

/** One row of a table that says there is nothing, or nothing that matches. */
export function EmptyRow({ columns, children }: Readonly<{ columns: number; children: ReactNode }>) {
  return (
    <tr>
      <td colSpan={columns} className="h-20 border-b px-4 text-center whitespace-normal text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

/** A status: a small dot and a word. */
export function StatusDot({ tone, children }: Readonly<{ tone: "ok" | "warn" | "error" | "busy" | "idle"; children: ReactNode }>) {
  const dot =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "error"
          ? "bg-red-500"
          : tone === "busy"
            ? "bg-sky-500"
            : "bg-muted-foreground/60";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {children}
    </span>
  );
}

/** One row's details, over the page from the right; its actions in a ⋯ menu beside its title. */
export function SidePanel({
  title,
  description,
  actions = [],
  footer,
  onClose,
  children,
  wide = false,
}: Readonly<{
  title: string;
  description?: ReactNode;
  actions?: readonly MenuAction[];
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}>) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className={cn("w-full gap-0 overflow-hidden", wide ? "sm:max-w-xl" : "sm:max-w-md")}>
        <SheetHeader className="flex-row items-start gap-2 border-b py-3.5 pr-12 pl-5">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-sm">{title}</SheetTitle>
            {description ? (
              <SheetDescription className="truncate text-xs">{description}</SheetDescription>
            ) : (
              <SheetDescription className="sr-only">{title}</SheetDescription>
            )}
          </div>
          <ActionMenu label={`${title} actions`} actions={actions} />
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <SheetFooter className="flex-row justify-end border-t px-5 py-3">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}

/** A panel's fields: a label and its value, one per line. */
export function Fields({ entries }: Readonly<{ entries: readonly (readonly [string, ReactNode])[] }>) {
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {entries.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="break-words">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A block of JSON or other text a panel shows as it is. */
export function CodeBlock({ children, label }: Readonly<{ children: ReactNode; label?: string }>) {
  return (
    <div className="space-y-1.5">
      {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}
