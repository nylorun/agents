/**
 * Runs the conformance checks against a live Runtime, through its public APIs only.
 *
 * Setup: the Tenant's fixture model is turned on (it stays on: run this against a Tenant for
 * testing), a manifest-only agent is registered, and Environments are created with `harness` set
 * to the harness under test (`none` for text turns, `virtual` for bash turns, `pod` for the pod
 * profile). Each check then sends marker messages the fixture model answers the same way every
 * time (`conformance:text`, `conformance:tool bash {...}`, `conformance:unoffered`,
 * `conformance:budget`, `conformance:slow <s>`) and reads what the Runtime recorded: the
 * session's events, its metered model calls, its journaled tool calls, and its sandbox routes.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CHECKS, type CheckClass, type CheckInfo } from "./catalog.js";
import { RuntimeClient, type ModelCallRow, type RecordEvent } from "./client.js";
import * as judge from "./evaluate.js";
import type { TurnObservation, Verdict } from "./evaluate.js";

export type Status = "pass" | "fail" | "skipped" | "n/a";

export interface CheckResult {
  readonly id: string;
  /** False only when the check ran and failed. */
  readonly ok: boolean;
  readonly status: Status;
  readonly detail: string;
  readonly section: string;
  readonly class: CheckClass;
  readonly title: string;
  readonly ms: number;
}

export interface ConformanceOptions {
  /** The Runtime's base URL. */
  readonly runtime: string;
  /** An application key (Runtime API). */
  readonly key: string;
  /** A management key (Management API): the fixture model's seed and the Tenant's status. */
  readonly manageKey: string;
  /** The harness id under test: what it says in `hello.name`. */
  readonly harness: string;
  /** How the harness runs: beside the Runtime (`container`, default) or as a sandbox pod's image. */
  readonly profile?: "container" | "pod";
  /** The harness's image, for the pod profile. */
  readonly image?: string;
  /** Runs HC10, a 16-minute turn. */
  readonly long?: boolean;
  /** Restarts the harness (a shell command, or a function): runs HC07 and HC08. */
  readonly restart?: string | (() => Promise<void>);
  /** The harness serves workspaces (declared `workspace` in `hello`): runs HC16. */
  readonly workspace?: boolean;
  /** A remote MCP server the Runtime can reach and one of its tools, as the model sees it: runs HC17. */
  readonly mcp?: {
    readonly url: string;
    readonly tool: string;
    readonly args?: Record<string, unknown>;
  };
  /** Values that must never appear in what the session's readers see (HC14), e.g. the harness's token. */
  readonly secrets?: readonly string[];
  /** Runs only these checks. */
  readonly only?: readonly string[];
  /** How long one turn may take. Default 60 s (300 s in a pod). */
  readonly turnTimeoutMs?: number;
  /** Names the agent, Environments and sessions this run creates. Default random. */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  /** Called as each check finishes. */
  readonly onResult?: (result: CheckResult) => void;
  readonly log?: (message: string) => void;
}

export interface ConformanceReport {
  readonly harness: string;
  readonly profile: "container" | "pod";
  readonly runtime: string;
  readonly protocol?: number;
  readonly results: readonly CheckResult[];
  /** No check that applied failed. */
  readonly ok: boolean;
}

/** What the fixture model's markers make a bash call print. */
const BASH_OUT = "nylorun-conformance-42";
const UNOFFERED = "nylorun_conformance_unoffered";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const tool = (name: string, args: Record<string, unknown>) =>
  `conformance:tool ${name} ${JSON.stringify(args)}`;

/** A manifest-only agent: instructions only. The session's Environment gives it the sandbox. */
function manifestOf(id: string, mcp?: ConformanceOptions["mcp"]) {
  return {
    manifestSchemaVersion: 5,
    id,
    name: "Harness conformance",
    capabilities: [
      {
        id: "agent",
        type: "agent",
        instructions: ["You are the harness conformance agent. Answer briefly."],
      },
      ...(mcp
        ? [
            {
              id: "mcp",
              type: "agent",
              mcpServers: {
                conformance: { name: "conformance", type: "streamable-http", url: mcp.url },
              },
            },
          ]
        : []),
    ],
  };
}

/** Drives sessions and reads back what the Runtime recorded of each turn. */
class Driver {
  readonly sessions: string[] = [];
  readonly environments: string[] = [];
  private requests = 0;

  constructor(
    readonly client: RuntimeClient,
    readonly prefix: string,
    readonly harness: string,
    readonly turnTimeoutMs: number,
    readonly log: (message: string) => void,
    /** The pod profile's image: every session then runs in the harness's pod. */
    readonly podImage?: string,
  ) {}

  get agentId() {
    return `${this.prefix}-agent`;
  }
  env(kind: "none" | "box" | "pod") {
    return `${this.prefix}-${kind}`;
  }

  /**
   * The Environment of `kind` whose harness is the one under test: `none` (no sandbox), `box` (a
   * virtual sandbox) or `pod`. In the pod profile every kind is the pod: the harness runs nowhere
   * else.
   */
  async environment(kind: "none" | "box" | "pod"): Promise<string> {
    if (this.podImage !== undefined) kind = "pod";
    const id = this.env(kind);
    if (!this.environments.includes(id)) {
      await this.client.putEnvironment(id, {
        kind: kind === "box" ? "virtual" : kind,
        harness: this.harness,
        ...(kind === "pod" ? { image: this.podImage! } : {}),
      });
      this.environments.push(id);
    }
    return id;
  }

  async open(name: string, environment?: string, agentId = this.agentId): Promise<string> {
    const id = `${this.prefix}-${name}`;
    await this.client.openSession(id, {
      agentId,
      ownerUserId: "nylorun-conformance",
      ...(environment ? { environment } : {}),
    });
    this.sessions.push(id);
    return id;
  }

  /** Sends `content` without waiting: the turn's id. */
  async send(sessionId: string, content: string): Promise<string> {
    const requestId = `${sessionId}-m${(this.requests += 1)}`;
    const answer = await this.client.command(sessionId, {
      type: "message",
      requestId,
      idempotencyKey: requestId,
      content,
    });
    if (typeof answer?.turnId === "string") return answer.turnId;
    const event = (await this.client.items(sessionId)).find(
      (item) => item.type === "command.message" && item.payload?.requestId === requestId,
    );
    if (!event?.turnId) throw new Error(`The message to ${sessionId} started no turn`);
    return event.turnId;
  }

  /** Cancels the session's turn; when the cancel was answered. */
  async cancel(sessionId: string): Promise<number> {
    const requestId = `${sessionId}-c${(this.requests += 1)}`;
    await this.client.command(sessionId, { type: "cancel", requestId, idempotencyKey: requestId });
    return Date.now();
  }

  /** Waits for turn `turnId` to end: a terminal event, or a status that waits on someone else. */
  async wait(
    sessionId: string,
    turnId: string,
    timeoutMs = this.turnTimeoutMs,
  ): Promise<TurnObservation> {
    const deadline = Date.now() + timeoutMs;
    for (let probe = 0; ; probe += 1) {
      const items = await this.client.items(sessionId);
      if (items.some((item) => item.turnId === turnId && judge.isTerminal(item))) break;
      if (probe % 5 === 4) {
        const view = await this.client.session(sessionId);
        if (["uncertain", "waiting", "paused"].includes(view.status)) break;
      }
      if (Date.now() > deadline)
        throw new Error(
          `turn ${turnId} of ${sessionId} did not end within ${Math.round(timeoutMs / 1000)} s`,
        );
      await sleep(100);
    }
    return this.observe(sessionId, turnId);
  }

  async observe(sessionId: string, turnId: string): Promise<TurnObservation> {
    const [items, view, modelCalls, toolCalls] = await Promise.all([
      this.client.items(sessionId),
      this.client.session(sessionId),
      this.client.modelCalls(sessionId, turnId),
      this.client.toolCalls(sessionId, turnId),
    ]);
    const ofTurn = items.filter((item) => item.turnId === turnId);
    return {
      sessionId,
      turnId,
      items: ofTurn,
      ...(ofTurn.find(judge.isTerminal) ? { terminal: ofTurn.find(judge.isTerminal)! } : {}),
      status: view.status,
      modelCalls,
      toolCalls,
    };
  }

  async turn(sessionId: string, content: string, timeoutMs?: number): Promise<TurnObservation> {
    return this.wait(sessionId, await this.send(sessionId, content), timeoutMs);
  }

  /** Polls `probe` until `done`, at most `timeoutMs`. */
  async until<T>(
    probe: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
    timeoutMs = this.turnTimeoutMs,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }
}

type Run = (context: Context) => Promise<Verdict>;

interface Context {
  readonly options: ConformanceOptions;
  readonly driver: Driver;
  /** A scenario's result, computed once and shared by the checks that read it. */
  scenario<T>(name: string, run: () => Promise<T>): Promise<T>;
}

/** A check that applies only when `when` says so; otherwise skipped (required) or n/a. */
interface Gate {
  readonly applies: (options: ConformanceOptions) => boolean;
  readonly why: string;
  readonly status: "skipped" | "n/a";
}

const GATES: Record<NonNullable<CheckInfo["needs"]>, Gate> = {
  restart: {
    applies: (o) => o.restart !== undefined,
    why: "needs --restart <command>",
    status: "skipped",
  },
  long: {
    applies: (o) => o.long === true,
    why: "needs --long (a 16-minute turn)",
    status: "skipped",
  },
  pod: {
    applies: (o) => o.profile === "pod",
    why: "the pod profile only (--profile pod --image <ref>)",
    status: "n/a",
  },
  workspace: {
    applies: (o) => o.workspace === true,
    why: "the harness does not declare workspace (--workspace)",
    status: "n/a",
  },
  mcp: {
    applies: (o) => o.mcp !== undefined,
    why: "the harness's MCP is not under test (--mcp-url, --mcp-tool)",
    status: "n/a",
  },
};

// The scenarios, each shared by the checks that read it.

const textTurns = (c: Context) =>
  c.scenario("text", async () => {
    const session = await c.driver.open("text", await c.driver.environment("none"));
    const turns: TurnObservation[] = [];
    for (let n = 0; n < 3; n += 1) turns.push(await c.driver.turn(session, "conformance:text"));
    return turns;
  });

const bashTurn = (c: Context) =>
  c.scenario("bash", async () => {
    const session = await c.driver.open("bash", await c.driver.environment("box"));
    // The output differs from the command, so the command ran; `env` shows what commands get.
    return c.driver.turn(
      session,
      tool("bash", { command: "echo nylorun-conformance-$((6*7)); env" }),
    );
  });

const restartTurn = (c: Context) =>
  c.scenario("restart", async () => {
    const { driver } = c;
    const session = await driver.open("restart", await driver.environment("box"));
    const marker = `${driver.prefix}.marker`;
    const turnId = await driver.send(
      session,
      tool("bash", { command: `echo ran >> ${marker}; sleep 30` }),
    );
    // The first model outcome is recorded once its bash call is journaled.
    await driver.until(
      () => driver.client.toolCalls(session, turnId),
      (rows) => rows.length > 0,
      "the bash call to be journaled",
    );
    await sleep(1_000);
    const before = await driver.client.modelCalls(session, turnId);
    await restartHarness(c.options.restart!, driver.log);
    const turn = await driver.wait(session, turnId, Math.max(driver.turnTimeoutMs, 180_000));
    let runs: number | undefined;
    try {
      const count = await driver.turn(session, tool("bash", { command: `wc -l < ${marker}` }));
      const out = count.items.find((event) => event.type === "tool.completed")?.payload?.output
        ?.stdout;
      if (typeof out === "string" && /^\s*\d+\s*$/.test(out)) runs = Number(out.trim());
    } catch (error) {
      driver.log(`reading the marker back failed: ${message(error)}`);
    }
    return { turn, before, runs };
  });

async function restartHarness(
  restart: NonNullable<ConformanceOptions["restart"]>,
  log: (message: string) => void,
) {
  if (typeof restart === "function") return restart();
  log(`restarting the harness: ${restart}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(restart, { shell: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${restart} exited ${code}`)),
    );
  });
}

const CHECK_RUNS: Record<string, Run> = {
  async HC01(c) {
    const tenant = await c.driver.client.tenant();
    const connected = tenant?.harness?.connected;
    if (typeof connected === "number" && connected < 1)
      return { ok: false, detail: "the Tenant reports no harness connected" };
    return judge.tookRun((await textTurns(c))[0]!, c.options.harness);
  },
  async HC02(c) {
    return judge.oneRun([...(await textTurns(c)), await bashTurn(c)]);
  },
  async HC03(c) {
    const [first, second] = await textTurns(c);
    return judge.textTurn(first!, second!);
  },
  async HC04(c) {
    return judge.meteredOnce([...(await textTurns(c)), await bashTurn(c)]);
  },
  async HC05(c) {
    return judge.bashTurn(await bashTurn(c), BASH_OUT);
  },
  async HC06(c) {
    const prefixed = judge.effectIdsPrefixed([...(await textTurns(c)), await bashTurn(c)]);
    if (!prefixed.ok || c.options.restart === undefined) return prefixed;
    const { turn, before } = await restartTurn(c);
    const stable = judge.replayedAfterRestart(turn, before);
    return judge.all([
      prefixed,
      stable.ok ? { ok: true, detail: "stable across a restart" } : stable,
    ]);
  },
  async HC07(c) {
    const { turn, before } = await restartTurn(c);
    return judge.replayedAfterRestart(turn, before);
  },
  async HC08(c) {
    const { turn, runs } = await restartTurn(c);
    return judge.interruptedOnce(turn, runs);
  },
  async HC09(c) {
    const { driver } = c;
    // During a model call: the fixture model answers after 5 s, unless the call is cancelled.
    const quiet = await driver.open("cancel-model", await driver.environment("none"));
    const sent = Date.now();
    const modelTurn = await driver.send(quiet, "conformance:slow 5");
    await driver.until(
      () => driver.client.session(quiet),
      (view) => view.status === "running",
      "the turn to run",
    );
    await sleep(1_000);
    const modelAt = await driver.cancel(quiet);
    let model = await driver.wait(quiet, modelTurn, 10_000);
    const modelMs = Date.now() - modelAt;
    // Past the 5 s the call would have taken, it must still not be metered: the gate cancelled it.
    await sleep(Math.max(0, sent + 6_500 - Date.now()));
    model = await driver.observe(quiet, modelTurn);

    // During a command.
    const busy = await driver.open("cancel-command", await driver.environment("box"));
    const commandTurn = await driver.send(busy, tool("bash", { command: "sleep 20" }));
    await driver.until(
      () => driver.client.toolCalls(busy, commandTurn),
      (rows) => rows.length > 0,
      "the command to start",
    );
    await sleep(300);
    const commandAt = await driver.cancel(busy);
    let command = await driver.wait(busy, commandTurn, 10_000);
    const commandMs = Date.now() - commandAt;
    await sleep(500);
    command = await driver.observe(busy, commandTurn);
    return judge.cancelled(
      { what: "a model call", turn: model, ms: modelMs },
      { what: "a command", turn: command, ms: commandMs },
    );
  },
  async HC10(c) {
    const session = await c.driver.open("long", await c.driver.environment("box"));
    const turn = await c.driver.turn(
      session,
      tool("bash", { command: "sleep 960; echo nylorun-conformance-long", timeout: 1_000 }),
      20 * 60_000,
    );
    return judge.longTurn(turn, "nylorun-conformance-long");
  },
  async HC11(c) {
    const session = await c.driver.open("unoffered", await c.driver.environment("box"));
    const turn = await c.driver.turn(
      session,
      `conformance:unoffered ${UNOFFERED} ${JSON.stringify({ command: "echo should-not-run" })}`,
    );
    return judge.unofferedTool(turn, UNOFFERED);
  },
  async HC12(c) {
    const session = await c.driver.open("budget", await c.driver.environment("none"));
    const turn = await c.driver.turn(session, "conformance:budget");
    // A retry would come after the end: look again a moment later.
    await sleep(1_000);
    return judge.budgetRefused(await c.driver.observe(session, turn.turnId));
  },
  async HC13(c) {
    return judge.cursorAndState(await textTurns(c));
  },
  async HC14(c) {
    await bashTurn(c);
    const documents: { where: string; text: string }[] = [];
    for (const session of c.driver.sessions) {
      const [items, models, tools] = await Promise.all([
        c.driver.client.items(session),
        c.driver.client.modelCalls(session),
        c.driver.client.toolCalls(session),
      ]);
      documents.push(
        { where: `${session}'s items`, text: JSON.stringify(items) },
        { where: `${session}'s model calls`, text: JSON.stringify(models) },
        { where: `${session}'s tool calls`, text: JSON.stringify(tools) },
      );
    }
    return judge.noCredentials(documents, c.options.secrets ?? []);
  },
  async HC15(c) {
    if (!c.options.image)
      return { ok: false, detail: "the pod profile needs --image <ref>: the image is the harness" };
    const environment = await c.driver.environment("pod");
    const session = await c.driver.open("pod", environment);
    const turn = await c.driver.turn(
      session,
      tool("bash", { command: "echo nylorun-conformance-pod:$(pwd)" }),
      Math.max(c.driver.turnTimeoutMs, 300_000),
    );
    return judge.podTurn(turn, c.options.harness, "nylorun-conformance-pod:/workspace");
  },
  async HC16(c) {
    const { driver } = c;
    const session = await driver.open("workspace", await driver.environment("box"));
    await driver.turn(
      session,
      tool("bash", { command: "echo nylorun-conformance-ws > nylorun-conformance-ws.txt" }),
    );
    const read = await driver.client.sandbox(session, "read", {
      path: "nylorun-conformance-ws.txt",
    });
    const write = await driver.client.sandbox(session, "write", {
      path: "nylorun-conformance-put.txt",
      content: "nylorun-conformance-put",
    });
    const exec = await driver.client.sandbox(session, "bash", {
      command: "cat nylorun-conformance-put.txt",
    });
    const turnId = await driver.send(session, "conformance:slow 3");
    await driver.until(
      () => driver.client.session(session),
      (view) => view.activeTurnId === turnId,
      "the turn to start",
    );
    const during = await driver.client.sandbox(session, "read", {
      path: "nylorun-conformance-ws.txt",
    });
    await driver.wait(session, turnId);
    return judge.workspaceServed(
      { read, write, exec, during },
      "nylorun-conformance-ws",
      "nylorun-conformance-put",
    );
  },
  async HC17(c) {
    const { driver } = c;
    const mcp = c.options.mcp!;
    const agentId = `${driver.prefix}-mcp-agent`;
    await driver.client.putAgent(agentId, manifestOf(agentId, mcp), `${agentId}-put`);
    const session = await driver.open("mcp", await driver.environment("none"), agentId);
    const turn = await driver.turn(session, tool(mcp.tool, mcp.args ?? {}));
    return judge.mcpCalled(turn, await driver.client.session(session), mcp.tool);
  },
  async HC18(c) {
    const { driver } = c;
    const ours = await driver.open("routing-ours");
    const theirs = await driver.open("routing-theirs", await driver.environment("none"));
    // Both at once: each harness must take only its own.
    const [oursTurn, theirsTurn] = await Promise.all([
      driver.send(ours, "conformance:text"),
      driver.send(theirs, "conformance:text"),
    ]);
    const [a, b] = await Promise.all([
      driver.wait(ours, oursTurn),
      driver.wait(theirs, theirsTurn),
    ]);
    return judge.routed([
      { harness: "nylorun", view: await driver.client.session(ours), turn: a },
      { harness: c.options.harness, view: await driver.client.session(theirs), turn: b },
    ]);
  },
  async HC19(c) {
    return judge.attributed([...(await textTurns(c)), await bashTurn(c)], c.options.harness);
  },
};

/** Runs the checks; never throws for a failing check, only for options it cannot use. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(options.harness))
    throw new Error(
      `--harness ${JSON.stringify(options.harness)} is not a harness id: lowercase letters, digits and dashes, starting with a letter`,
    );
  const profile = options.profile ?? "container";
  if (profile === "pod" && !options.image)
    throw new Error("The pod profile needs --image <ref>: the image is the harness");
  const log = options.log ?? (() => undefined);
  const client = new RuntimeClient({
    runtime: options.runtime,
    key: options.key,
    manageKey: options.manageKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const prefix = options.prefix ?? `hc-${randomBytes(4).toString("hex")}`;
  const driver = new Driver(
    client,
    prefix,
    options.harness,
    options.turnTimeoutMs ?? (profile === "pod" ? 300_000 : 60_000),
    log,
    profile === "pod" ? options.image : undefined,
  );
  const scenarios = new Map<string, Promise<unknown>>();
  const context: Context = {
    options,
    driver,
    scenario: (name, run) => {
      if (!scenarios.has(name)) scenarios.set(name, run());
      return scenarios.get(name) as Promise<never>;
    },
  };

  const results: CheckResult[] = [];
  const record = (info: CheckInfo, status: Status, detail: string, ms = 0) => {
    const result: CheckResult = {
      id: info.id,
      ok: status !== "fail",
      status,
      detail,
      section: info.section,
      class: info.class,
      title: info.title,
      ms,
    };
    results.push(result);
    options.onResult?.(result);
  };

  let protocol: number | undefined;
  let setup: string | undefined;
  try {
    protocol = (await client.health()).protocol;
    await client.seedFixtureModel(`${prefix}-fixture`);
    await client.putAgent(driver.agentId, manifestOf(driver.agentId), `${prefix}-agent-put`);
  } catch (error) {
    setup = `setup failed: ${message(error)}`;
  }

  const selected = CHECKS.filter((check) => !options.only || options.only.includes(check.id));
  for (const info of selected) {
    const gate = info.needs ? GATES[info.needs] : undefined;
    if (gate && !gate.applies(options)) {
      record(info, gate.status, gate.why);
      continue;
    }
    if (setup) {
      record(info, "fail", setup);
      continue;
    }
    const started = Date.now();
    log(`${info.id} ${info.title}`);
    try {
      const verdict = await CHECK_RUNS[info.id]!(context);
      record(info, verdict.ok ? "pass" : "fail", verdict.detail, Date.now() - started);
    } catch (error) {
      record(info, "fail", message(error), Date.now() - started);
    }
  }

  for (const id of driver.environments)
    await client
      .deleteEnvironment(id)
      .catch((error: unknown) => log(`could not delete Environment ${id}: ${message(error)}`));

  return {
    harness: options.harness,
    profile,
    runtime: options.runtime,
    ...(protocol === undefined ? {} : { protocol }),
    results,
    ok: results.every((result) => result.ok),
  };
}

export type { RecordEvent, ModelCallRow };
