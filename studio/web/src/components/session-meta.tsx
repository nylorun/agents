import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_DOT } from "@/lib/status";

const DOT: Record<string, string> = {
  loading: STATUS_DOT.idle,
  running: `${STATUS_DOT.running} animate-pulse`,
  runnable: `${STATUS_DOT.running} animate-pulse`,
  waiting: `${STATUS_DOT.running} animate-pulse`,
  paused: STATUS_DOT.attention,
  uncertain: STATUS_DOT.attention,
  failed: STATUS_DOT.attention,
  completed: STATUS_DOT.idle,
  idle: STATUS_DOT.idle,
};

/** A session's status as a dot and a word. */
export function SessionStatus({ status }: Readonly<{ status: string }>) {
  return (
    <span
      role="status"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", DOT[status] ?? STATUS_DOT.idle)}
      />
      {status}
    </span>
  );
}

/** The session's id, shortened; a click copies the whole id. */
export function SessionIdCopy({ id }: Readonly<{ id: string }>) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="inline-flex min-w-0 shrink items-center gap-1 rounded px-1 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title={`${id} (click to copy)`}
      aria-label={`Copy session id ${id}`}
      onClick={() =>
        void navigator.clipboard
          .writeText(id)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      <span className="truncate">{id.slice(0, 8)}</span>
      {copied ? (
        <Check className="size-3 shrink-0" aria-hidden />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60" aria-hidden />
      )}
    </button>
  );
}
