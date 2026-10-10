import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

export function ResourceLayout({
  children,
  inspector,
  title,
  onClose,
}: {
  children: ReactNode;
  inspector?: ReactNode;
  title: string;
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  if (mobile)
    return (
      <>
        <section className="h-full min-h-0 flex-1 overflow-auto">
          {children}
        </section>
        <Sheet
          open={inspector !== undefined}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <SheetContent
            className="w-full gap-0 overflow-hidden sm:max-w-lg"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">{title}</SheetTitle>
            <SheetDescription className="sr-only">
              Resource details
            </SheetDescription>
            {inspector}
          </SheetContent>
        </Sheet>
      </>
    );
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={inspector ? "60%" : "100%"} minSize="30%">
        <section className="h-full min-h-0 flex-1 overflow-auto">
          {children}
        </section>
      </ResizablePanel>
      {inspector ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="40%" minSize="30%">
            {inspector}
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}

export function ResourceHeader({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
      <h2 className="min-w-0 flex-1 break-all text-sm font-medium">{title}</h2>
      {children}
      {onClose ? (
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label="Close resource details"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </header>
  );
}

export function ReadState({
  pending,
  error,
  empty,
  onRetry,
}: {
  pending: boolean;
  error: string;
  empty?: string;
  onRetry: () => void;
}) {
  return (
    <>
      {pending ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-2 p-4 text-sm">
          <p className="break-words">{error}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {!pending && !error && empty ? (
        <p className="p-4 text-sm text-muted-foreground">{empty}</p>
      ) : null}
    </>
  );
}

export function Metadata({ entries }: { entries: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {entries.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="break-all">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
