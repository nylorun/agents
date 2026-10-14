import { Badge } from "@/components/ui/badge";
import {
  coverageCredentialLabel,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  type Coverage,
} from "@/credential-coverage";

const TONE_CLASS = {
  ok: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  error: "border-red-600/50 text-red-600 dark:text-red-400",
} as const;

/**
 * What an agent's MCP servers and HTTP tools get from an Environment's secrets, one entry each,
 * as the Runtime checked it (`credential-coverage`). The New session sheet and a session's
 * Environment tab show it.
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
              <Badge variant="outline" className={TONE_CLASS[tone]}>
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
