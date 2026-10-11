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
import type { EnvironmentView } from "@nylorun/agents";
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
  coverageCredentialLabel,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  environmentUnavailable,
  type Coverage,
} from "@/credential-coverage";
import { createTenantClient, createTenantManagementClient } from "@/proxy-client";
import {
  STUDIO_OWNER,
  newSessionState,
  type NewSessionEnvironment,
} from "@/session-open";

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
 * Starts Studio's new sessions. When the Tenant has Environments, or the agent's MCP servers or
 * HTTP tools take a credential, the Environment picker comes first: the session's sandbox and
 * credentials are the Environment's, and without one it has neither. Otherwise the session
 * starts at once.
 */
export function NewSessionProvider({
  tenantId,
  children,
}: Readonly<{ tenantId: string; children: ReactNode }>) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<{
    agent: SessionAgent;
    environments: EnvironmentView[];
    coverage?: Coverage;
  }>();
  const starting = useRef(false);
  const open = useCallback(
    (agent: SessionAgent, choice: NewSessionEnvironment = {}) =>
      void navigate(sessionPath(agent.id), { state: newSessionState(choice) }),
    [navigate],
  );
  const start = useCallback(
    (agent: SessionAgent) => {
      if (starting.current) return;
      starting.current = true;
      void Promise.all([
        createTenantClient(tenantId)
          .environments.list()
          .then(
            (listed) => (Array.isArray(listed) ? listed : []),
            () => [],
          ),
        // A Runtime without credential coverage: no entries to show.
        createTenantManagementClient(tenantId)
          .coverage({ agentId: agent.id })
          .then(
            (coverage) => (Array.isArray(coverage.entries) ? coverage : undefined),
            () => undefined,
          ),
      ])
        .then(([environments, coverage]) => {
          // Nothing to pick: the session starts without an Environment.
          if (environments.length === 0 && !coverage?.entries.length) open(agent);
          else setPending({ agent, environments, ...(coverage ? { coverage } : {}) });
        })
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
          environments={pending.environments}
          initial={pending.coverage}
          onCancel={() => setPending(undefined)}
          onStart={(choice) => {
            setPending(undefined);
            open(pending.agent, choice);
          }}
        />
      ) : null}
    </NewSessionContext.Provider>
  );
}

/** Starts a new session of `agent`: through the Environment picker inside `NewSessionProvider`. */
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
 * The Environment a new session names, or none, with what the agent's MCP servers and HTTP
 * tools would get from its secrets, checked by the Runtime as the session's calls would
 * (`credential-coverage`). An Environment whose owner guard names another owner than Studio's
 * cannot be picked.
 */
function NewSessionSheet({
  tenantId,
  agent,
  environments,
  initial,
  onCancel,
  onStart,
}: Readonly<{
  tenantId: string;
  agent: SessionAgent;
  environments: readonly EnvironmentView[];
  initial?: Coverage;
  onCancel: () => void;
  onStart: (choice: NewSessionEnvironment) => void;
}>) {
  const sdk = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const [environmentId, setEnvironmentId] = useState("");
  const [coverage, setCoverage] = useState<Coverage | undefined>(initial);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const checks = initial !== undefined;

  useEffect(() => {
    if (!checks) return;
    let current = true;
    setChecking(true);
    sdk
      .coverage({ agentId: agent.id, ...(environmentId ? { environmentId } : {}) })
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
  }, [sdk, agent.id, environmentId, checks]);

  const counts = coverage ? coverageCounts(coverage) : undefined;
  const picked = environments.find((environment) => environment.id === environmentId);

  return (
    <Sheet open onOpenChange={(open) => !open && onCancel()}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New session · {agent.name}</SheetTitle>
          <SheetDescription>
            Pick the Environment the session runs in: its sandbox, and the secrets this
            agent's MCP servers, HTTP tools and shell use. A credential is sent only to the
            URL it is bound to.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4">
          <section aria-labelledby="new-session-environment" className="grid gap-2">
            <h3 id="new-session-environment" className="text-sm font-medium">
              Environment
            </h3>
            <ul className="grid gap-1">
              <li>
                <label className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
                  <input
                    type="radio"
                    name="new-session-environment"
                    className="size-4"
                    checked={environmentId === ""}
                    onChange={() => setEnvironmentId("")}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">None</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    no sandbox, no credentials
                  </span>
                </label>
              </li>
              {environments.map((environment) => {
                const unavailable = environmentUnavailable(environment, STUDIO_OWNER);
                return (
                  <li key={environment.id}>
                    <label
                      className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${unavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/50"}`}
                      title={unavailable}
                    >
                      <input
                        type="radio"
                        name="new-session-environment"
                        className="size-4"
                        disabled={unavailable !== undefined}
                        checked={environmentId === environment.id}
                        onChange={() => setEnvironmentId(environment.id)}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {environment.id}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {unavailable ?? environment.kind}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {environments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This Tenant has no Environments yet. Create one, and write its credentials,
                on the{" "}
                <Link className="text-primary underline underline-offset-4" to="/environments">
                  Environments page
                </Link>
                .
              </p>
            ) : null}
          </section>

          {coverage && coverage.entries.length > 0 ? (
            <section aria-labelledby="new-session-coverage" className="grid gap-2">
              <h3 id="new-session-coverage" className="text-sm font-medium">
                What the tools get{checking ? " · checking…" : ""}
              </h3>
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
              {picked ? (
                <Link
                  className="text-sm text-primary underline underline-offset-4"
                  to={`/settings/credentials?${new URLSearchParams({ environment: picked.id })}`}
                >
                  Manage {picked.id}'s credentials
                </Link>
              ) : null}
            </section>
          ) : null}
          {problem ? (
            <p role="alert" className="text-sm text-red-600">
              {problem}
            </p>
          ) : null}
        </div>
        <SheetFooter className="flex-row items-center gap-2">
          <p className="mr-auto text-sm text-muted-foreground" role="status">
            {coverage && counts && coverage.entries.length > 0
              ? `${counts.covered} of ${coverage.entries.length} covered${counts.error ? ` · ${counts.error} would fail` : ""}`
              : null}
          </p>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={checking}
            onClick={() => onStart(environmentId ? { environment: environmentId } : {})}
          >
            Start session
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
