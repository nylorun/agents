import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  groupIterationsByPath,
  type IterationRecord,
} from "@/workflow";

function IterationRow({
  row,
  selected,
  onSelect,
}: Readonly<{
  row: IterationRecord;
  selected?: boolean;
  onSelect?: (row: IterationRecord) => void;
}>) {
  return (
    <button
      type="button"
      className={`flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm ${
        selected ? "border-primary bg-muted" : "border-border"
      }`}
      onClick={() => onSelect?.(row)}
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          #{row.n}
        </Badge>
        {row.pass === true ? (
          <Badge variant="outline">pass</Badge>
        ) : row.pass === false ? (
          <Badge variant="destructive">fail</Badge>
        ) : null}
        {row.waiting ? <Badge variant="outline">waiting</Badge> : null}
      </div>
      {row.feedback ? (
        <p className="text-xs text-muted-foreground">{row.feedback}</p>
      ) : null}
    </button>
  );
}

export function IterationTimeline({
  rows,
  selected,
  onSelect,
}: Readonly<{
  rows: readonly IterationRecord[];
  selected?: IterationRecord;
  onSelect?: (row: IterationRecord) => void;
}>) {
  const groups = groupIterationsByPath(rows);
  if (rows.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Loop iterations will appear here as the workflow runs.
      </p>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        {[...groups.entries()].map(([path, list]) => (
          <section key={path} className="space-y-2">
            <h3 className="font-mono text-xs text-muted-foreground">{path}</h3>
            <div className="space-y-2">
              {list.map((row) => (
                <IterationRow
                  key={`${row.path}:${row.n}`}
                  row={row}
                  selected={
                    selected?.path === row.path && selected.n === row.n
                  }
                  onSelect={onSelect}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
