import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import type { VaultInfo } from "@nylorun/agents";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  coverageCounts,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  credentialChoices,
  keptPicks,
  selectionsOf,
  suggestedVaultIds,
  vaultHolds,
  type Coverage,
  type PickedCredential,
} from "@/credential-coverage";
import { createTenantManagementClient } from "@/proxy-client";
import { newSessionState, type NewSessionCredentials } from "@/session-open";

/** The agent a new session runs. */
type SessionAgent = { readonly id: string; readonly name: string };

const NewSessionContext = createContext<((agent: SessionAgent) => void) | undefined>(undefined);

function sessionPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/sessions/${crypto.randomUUID()}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Starts Studio's new sessions. An agent whose MCP servers or HTTP tools take a credential gets
 * the vault picker first, with the vaults that hold one suggested; any other agent's session
 * starts at once, as does every session on a Runtime without credential coverage.
 */
export function NewSessionProvider({
  tenantId,
  children,
}: Readonly<{ tenantId: string; children: ReactNode }>) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<{ agent: SessionAgent; coverage: Coverage }>();
  const starting = useRef(false);
  const open = useCallback(
    (agent: SessionAgent, credentials: NewSessionCredentials = {}) =>
      void navigate(sessionPath(agent.id), { state: newSessionState(credentials) }),
    [navigate],
  );
  const start = useCallback(
    (agent: SessionAgent) => {
      if (starting.current) return;
      starting.current = true;
      void createTenantManagementClient(tenantId)
        .vaults.coverage({ agentId: agent.id })
        .then(
          (coverage) => {
            // No entries (or a Runtime answering without them): nothing to pick.
            if (!Array.isArray(coverage.entries) || coverage.entries.length === 0) open(agent);
            else setPending({ agent, coverage });
          },
          // A Runtime without credential coverage: the session starts with no vaults, as before.
          () => open(agent),
        )
        .finally(() => {
          starting.current = false;
        });
    },
    [tenantId, open],
  );
  return (
    <NewSessionContext.Provider value={start}>
      {children}
      {pending ? (
        <NewSessionSheet
          key={pending.agent.id}
          tenantId={tenantId}
          agent={pending.agent}
          initial={pending.coverage}
          onCancel={() => setPending(undefined)}
          onStart={(credentials) => {
            setPending(undefined);
            open(pending.agent, credentials);
          }}
        />
      ) : null}
    </NewSessionContext.Provider>
  );
}

/** Starts a new session of `agent`: through the vault picker inside `NewSessionProvider`. */
export function useStartSession(): (agent: SessionAgent) => void {
  const start = useContext(NewSessionContext);
  const navigate = useNavigate();
  return useMemo(
    () =>
      start ??
      ((agent: SessionAgent) =>
        void navigate(sessionPath(agent.id), { state: newSessionState() })),
    [start, navigate],
  );
}

const TONE_CLASS = {
  ok: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  error: "border-red-600/50 text-red-600 dark:text-red-400",
} as const;

/**
 * The installation vaults a new session attaches (Studio manages no person's vault), with what
 * the agent's MCP servers and HTTP tools would get from them, checked by the Runtime as the
 * session's calls would choose (`credential-coverage`).
 */
function NewSessionSheet({
  tenantId,
  agent,
  initial,
  onCancel,
  onStart,
}: Readonly<{
  tenantId: string;
  agent: SessionAgent;
  initial: Coverage;
  onCancel: () => void;
  onStart: (credentials: NewSessionCredentials) => void;
}>) {
  const sdk = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const [vaults, setVaults] = useState<VaultInfo[]>();
  const [vaultIds, setVaultIds] = useState<string[]>(() => suggestedVaultIds(initial));
  const [picks, setPicks] = useState<PickedCredential[]>([]);
  const [coverage, setCoverage] = useState<Coverage>(initial);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    let current = true;
    sdk.vaults.list().then(
      (listed) => current && setVaults(listed),
      (cause: unknown) => current && setProblem(messageOf(cause)),
    );
    return () => {
      current = false;
    };
  }, [sdk]);

  useEffect(() => {
    let current = true;
    setChecking(true);
    sdk.vaults
      .coverage({
        agentId: agent.id,
        vaultIds,
        credentialSelections: selectionsOf(picks),
      })
      .then(
        (next) => {
          if (!current) return;
          setCoverage(next);
          setProblem(undefined);
        },
        (cause: unknown) => current && setProblem(messageOf(cause)),
      )
      .finally(() => current && setChecking(false));
    return () => {
      current = false;
    };
  }, [sdk, agent.id, vaultIds, picks]);

  const toggle = (vaultId: string) => {
    const next = vaultIds.includes(vaultId)
      ? vaultIds.filter((id) => id !== vaultId)
      : (vaults ?? []).map((vault) => vault.id).filter((id) => id === vaultId || vaultIds.includes(id));
    setVaultIds(next);
    setPicks(keptPicks(picks, next));
  };
  const choices = credentialChoices(coverage);
  const pick = (serverName: string, credentialId: string) => {
    const others = picks.filter((item) => item.serverName !== serverName);
    const option = choices
      .find((choice) => choice.serverName === serverName)
      ?.options.find((item) => item.credentialId === credentialId);
    setPicks(option ? [...others, { serverName, credentialId, vaultId: option.vaultId }] : others);
  };
  const counts = coverageCounts(coverage);

  return (
    <Sheet open onOpenChange={(open) => !open && onCancel()}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New session · {agent.name}</SheetTitle>
          <SheetDescription>
            Attach the installation vaults whose credentials this agent's MCP servers and HTTP
            tools use. A credential is sent to the URL it is bound to.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4">
          <section aria-labelledby="new-session-vaults" className="grid gap-2">
            <h3 id="new-session-vaults" className="text-sm font-medium">
              Vaults
            </h3>
            {vaults === undefined ? (
              <p className="text-sm text-muted-foreground">Loading vaults…</p>
            ) : vaults.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This Tenant has no vaults yet. Add credentials on the{" "}
                <Link className="text-primary underline underline-offset-4" to="/settings/credentials">
                  Credentials page
                </Link>
                .
              </p>
            ) : (
              <ul className="grid gap-1">
                {vaults.map((vault) => {
                  const holds = vaultHolds(coverage, vault.id);
                  return (
                    <li key={vault.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={vaultIds.includes(vault.id)}
                          onChange={() => toggle(vault.id)}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{vault.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {holds === 0
                            ? "nothing for this agent"
                            : `holds ${holds} of ${coverage.entries.length}`}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="new-session-coverage" className="grid gap-2">
            <h3 id="new-session-coverage" className="text-sm font-medium">
              What the tools get{checking ? " · checking…" : ""}
            </h3>
            <ul className="grid gap-2">
              {coverage.entries.map((entry) => {
                const tone = coverageTone(entry);
                const choice = choices.find((item) => item.serverName === entry.serverName);
                const picked = picks.find((item) => item.serverName === entry.serverName);
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
                    <p className="text-muted-foreground">{entry.message}</p>
                    {choice ? (
                      <label className="grid gap-1 text-xs">
                        Credential for {entry.serverName}
                        <select
                          className="h-8 rounded-md border bg-transparent px-2 text-sm"
                          value={picked?.credentialId ?? ""}
                          onChange={(event) => pick(entry.serverName, event.target.value)}
                        >
                          <option value="">Pick a credential</option>
                          {choice.options.map((item) => (
                            <option key={item.credentialId} value={item.credentialId}>
                              {item.credentialName} · {item.vaultName}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
          {problem ? (
            <p role="alert" className="text-sm text-red-600">
              {problem}
            </p>
          ) : null}
        </div>
        <SheetFooter className="flex-row items-center gap-2">
          <p className="mr-auto text-sm text-muted-foreground" role="status">
            {counts.covered} of {coverage.entries.length} covered
            {counts.error ? ` · ${counts.error} would fail` : ""}
          </p>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={checking}
            onClick={() => onStart({ vaultIds, credentialSelections: selectionsOf(picks) })}
          >
            Start session
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
