import { useEffect, useState } from "react";
import { Braces, Check, Copy, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A chat message's ⋯ menu: copy its text, or open its event in the Events tab.
 * It shows while the message is hovered or focused, while open, and briefly
 * after a copy, when its icon turns to a check.
 */
export function MessageActions({
  label,
  text,
  onViewEvent,
}: Readonly<{
  /** Who wrote the message, for the menu's accessible name. */
  label: string;
  text: string;
  onViewEvent: () => void;
}>) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? "Copied" : `${label} message options`}
          title={copied ? "Copied" : "More options"}
          className={cn(
            "-my-1 -mr-1 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
            copied && "opacity-100",
          )}
        >
          {copied ? <Check className="size-4" /> : <MoreHorizontal className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem
          disabled={text === ""}
          onSelect={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          <Copy />
          Copy text
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onViewEvent}>
          <Braces />
          View event
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
