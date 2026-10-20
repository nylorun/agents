import { Badge } from "@/components/ui/badge";
import { STATUS_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";
import {
  coverageCredentialLabel,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  type Coverage,
} from "@/credential-coverage";

const TONE_DOT = {
  ok: STATUS_DOT.running,
  warn: STATUS_DOT.attention,
  error: STATUS_DOT.attention,
} as const;

/**
 * What an Agent's MCP servers and HTTP tools get from its vault's secrets, one entry each, as the
 * Runtime checked it (`credential-coverage`). An Agent's Secrets tab and a session's Manifest
 * tab (Deployed) show it.
 */
export function CoverageList({ coverage }: Readonly<{ coverage: Coverage }>) {
  return (
    <ul className="grid gap-2">
      {coverage.entries.map((entry) => {
        const tone = coverageTone(entry);
        const credential = coverageCredentialLabel(entry);
        return (
          <li
            key={`${entry.kind}:${entry.agentId ?? ""}:${entry.stage ?? ""}:${entry.name}`}
            className="grid gap-1 rounded-md border p-3 text-sm"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">
                {coverageEntryLabel(entry)}
              </span>
              <Badge variant="outline" className="gap-1.5">
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
                {coverageStatusLabel(entry)}
              </Badge>
            </div>
            <code className="truncate text-xs text-muted-foreground" title={entry.url}>
              {entry.url}
            </code>
            {credential ? (
              <p className="text-xs text-muted-foreground">Sends {credential}</p>
            ) : null}
            <p className="text-muted-foreground">{entry.message}</p>
          </li>
        );
      })}
    </ul>
  );
}
