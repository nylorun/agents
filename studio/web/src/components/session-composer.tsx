import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SessionModelPicker } from "@/components/session-model-picker";
import { cn } from "@/lib/utils";

/** The textarea grows with its content up to this height, then scrolls. */
const MAX_HEIGHT = 240;

/**
 * The message box under a session's chat: one card holding the text, the
 * model picker and a single action button. The button sends while the
 * session is idle and stops the turn while it runs.
 */
export function SessionComposer({
  tenantId,
  agentName,
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  sending,
  blocked,
}: Readonly<{
  tenantId: string;
  agentName: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onStop: () => void;
  /** A turn is in flight: the button stops it instead of sending. */
  running: boolean;
  /** The message is on its way to the Runtime. */
  sending: boolean;
  /** The session waits on an approval or needs attention; no input. */
  blocked: boolean;
}>) {
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const disabled = running || blocked;
  const canSend = !disabled && value.trim().length > 0;

  // Fit the box to its text; the panel's width changes the wrap, so refit on resize too.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
    };
    fit();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  // Focus returns to the box when a turn ends, so the next message is one keystroke away.
  useLayoutEffect(() => {
    if (!disabled) textarea.current?.focus({ preventScroll: true });
  }, [disabled]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
      return;
    event.preventDefault();
    if (canSend) form.current?.requestSubmit();
  }

  const placeholder = blocked
    ? "Answer the request above to continue"
    : running
      ? `${agentName} is working…`
      : `Message ${agentName}`;

  return (
    <form ref={form} onSubmit={onSubmit} className="shrink-0 px-4 pb-3 pt-2">
      <div
        className={cn(
          "rounded-xl border bg-background shadow-xs transition-[border-color,box-shadow]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
          disabled && "bg-muted/40",
        )}
      >
        <textarea
          ref={textarea}
          aria-label="Message"
          rows={1}
          className="block max-h-60 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <SessionModelPicker
            tenantId={tenantId}
            disabled={disabled}
            className="min-w-0 flex-1"
          />
          {running && !sending ? (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              aria-label="Stop"
              title="Stop"
              onClick={onStop}
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!canSend}
            >
              {sending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowUp />
              )}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
        <kbd className="font-sans">Enter</kbd> to send ·{" "}
        <kbd className="font-sans">Shift</kbd> +{" "}
        <kbd className="font-sans">Enter</kbd> for a new line
      </p>
    </form>
  );
}
