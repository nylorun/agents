import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, FileText, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SessionModelPicker } from "@/components/session-model-picker";
import { formatBytes, type ComposerAttachment } from "@/attachments";
import { cn } from "@/lib/utils";

/** The textarea grows with its content up to this height, then scrolls. */
const MAX_HEIGHT = 240;

/** One attached file: an image's thumbnail or a file icon, its name and size, and remove. */
function AttachmentChip({
  attachment,
  disabled,
  onRemove,
}: Readonly<{
  attachment: ComposerAttachment;
  disabled: boolean;
  onRemove: () => void;
}>) {
  const { file, error } = attachment;
  const [thumbnail, setThumbnail] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setThumbnail(url);
    return () => {
      URL.revokeObjectURL(url);
      setThumbnail("");
    };
  }, [file]);
  return (
    <li
      data-slot="attachment"
      aria-invalid={error ? true : undefined}
      title={error ?? file.name}
      className={cn(
        "flex max-w-56 items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-1.5 text-xs",
        error && "border-destructive/60 bg-destructive/5",
      )}
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" className="size-8 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
          <FileText className="size-4" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{file.name}</span>
        <span className={cn("block truncate", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? formatBytes(file.size)}
        </span>
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${file.name}`}
        title="Remove"
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </Button>
    </li>
  );
}

/**
 * The message box under a session's chat: one card holding attached files, the
 * text and its buttons, with the model picker under it. The paperclip, a paste
 * or a drop attaches files (sent as they are: nothing is resized or converted).
 * The button sends while the session is idle and stops the turn while it runs;
 * Enter sends and Shift+Enter adds a line.
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
  attachments,
  onAttach,
  onRemove,
  accept,
  onModelInputs,
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
  /** Files attached to the next message. */
  attachments: readonly ComposerAttachment[];
  onAttach: (files: readonly File[]) => void;
  onRemove: (id: string) => void;
  /** The file picker's `accept`: what the active model reads. */
  accept: string;
  /** The active model's inputs, as the model picker reads them. */
  onModelInputs?: (inputs: readonly string[]) => void;
}>) {
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const disabled = running || blocked;
  const canSend = !disabled && (value.trim().length > 0 || attachments.length > 0);

  function attach(files: FileList | null | undefined) {
    if (disabled || !files || files.length === 0) return;
    onAttach([...files]);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = event.clipboardData.files;
    if (files.length === 0) return;
    event.preventDefault();
    attach(files);
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (!disabled) setDragging(true);
  }
  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }
  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    attach(event.dataTransfer.files);
  }

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
    <form ref={form} onSubmit={onSubmit} className="shrink-0 border-t px-4 pb-3 pt-3">
      <div
        data-slot="composer-card"
        data-dragging={dragging || undefined}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "rounded-xl border bg-background shadow-xs transition-[border-color,box-shadow]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
          disabled && "bg-muted/40",
          dragging && "border-primary border-dashed ring-[3px] ring-primary/20",
        )}
      >
        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-2.5 pt-2.5">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                disabled={disabled}
                onRemove={() => onRemove(attachment.id)}
              />
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textarea}
          aria-label="Message"
          rows={1}
          className="block max-h-60 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-6 outline-none placeholder:text-muted-foreground aria-disabled:cursor-not-allowed"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          // Read-only, not disabled, while a turn runs: a disabled box drops focus,
          // and dictation and other assistive tools that paste into the focused
          // field lose their target for the next message.
          readOnly={disabled}
          aria-disabled={disabled || undefined}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <input
            ref={picker}
            type="file"
            multiple
            accept={accept}
            hidden
            onChange={(event) => {
              attach(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="rounded-full text-muted-foreground"
            aria-label="Attach files"
            title="Attach files"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <Paperclip />
          </Button>
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
      <SessionModelPicker
        tenantId={tenantId}
        disabled={disabled}
        className="mt-1"
        {...(onModelInputs ? { onInputs: onModelInputs } : {})}
      />
    </form>
  );
}
