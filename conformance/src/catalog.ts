/**
 * The conformance checklist (track R4, R4.7): what each check verifies, the section of the Harness
 * API reference it holds the harness to, and when it applies.
 *
 * - `required` checks apply to every harness. A few need something the suite cannot do alone: a
 *   restart of the harness (`--restart`) or a 16-minute turn (`--long`); without it they are
 *   skipped, never passed.
 * - `profile` checks apply to one way of running the harness: HC15 to a sandbox pod's image.
 * - `optional` checks apply to a capability the harness may declare: the workspace (HC16) or MCP
 *   (HC17). The suite cannot see what a harness said in `hello`, so they run when you say the
 *   harness has it (`--workspace`, `--mcp-url`), and are `n/a` otherwise.
 */
export type CheckClass = "required" | "profile" | "optional";

/** What a check needs before it runs. */
export type Need = "restart" | "long" | "pod" | "workspace" | "mcp";

export interface CheckInfo {
  readonly id: string;
  /** What it verifies, in one sentence. */
  readonly title: string;
  /** The sections of the Harness API reference it checks. */
  readonly section: string;
  readonly class: CheckClass;
  readonly needs?: Need;
}

export const CHECKS: readonly CheckInfo[] = [
  {
    id: "HC01",
    title:
      "Connects to the Harness API with its credential, says hello with Harness API 2 and its harness id, and takes the runs of a session pinned to it",
    section: "§1, §2",
    class: "required",
  },
  {
    id: "HC02",
    title:
      "A turn runs under one run, held by one connection: every event the harness reports carries that run's id",
    section: "§2",
    class: "required",
  },
  {
    id: "HC03",
    title:
      "A text turn settles turn.completed with the gate's answer as message.assistant and output, and its transcript edits are recorded: the next turn's prompt holds it",
    section: "§4, §6, §7",
    class: "required",
  },
  {
    id: "HC04",
    title:
      "Every model call goes through the Model Gate: one metered call per model effect, each with its own effect id, none from another model",
    section: "§5",
    class: "required",
  },
  {
    id: "HC05",
    title:
      "A bash call is journaled before it runs and settled once: one tool call row and one tool.completed with its output",
    section: "§4",
    class: "required",
  },
  {
    id: "HC06",
    title:
      "Effect ids carry the <turnId>:<segment>: prefix (and, with --restart, stay the same when the segment runs again)",
    section: "§4",
    class: "required",
  },
  {
    id: "HC07",
    title:
      "After a restart that follows a model outcome, the outcome replays from TurnStart.outcomes: no second gate call, no extra metered call",
    section: "§3, §4",
    class: "required",
    needs: "restart",
  },
  {
    id: "HC08",
    title:
      "A restart during a 30 s command leaves its call unsettled by the harness (interrupted or uncertain), and the command ran once",
    section: "§4, §8",
    class: "required",
    needs: "restart",
  },
  {
    id: "HC09",
    title:
      "A cancel during a model call and during a command ends the turn turn.cancelled within 2 s, and the keyed gate call is cancelled",
    section: "§8",
    class: "required",
  },
  {
    id: "HC10",
    title:
      "A 16-minute turn completes: the harness renews its lease and uses the newest run token after a re-mint",
    section: "§2, §5",
    class: "required",
    needs: "long",
  },
  {
    id: "HC11",
    title:
      "A call of a tool the turn does not offer runs nothing: the model hears it failed and the turn continues",
    section: "§4",
    class: "required",
  },
  {
    id: "HC12",
    title:
      "A budget refusal at the gate ends the turn model.budget_exhausted after one model call, with no retry",
    section: "§5, §7",
    class: "required",
  },
  {
    id: "HC13",
    title:
      "Each turn starts from the new transcript cursor and core accepts the harness's own state, turn after turn",
    section: "§3, §7",
    class: "required",
  },
  {
    id: "HC14",
    title:
      "No run, host or harness token appears in the session's items, model calls or tool outputs, even of a command that prints its environment",
    section: "§5, §9",
    class: "required",
  },
  {
    id: "HC15",
    title:
      "As a sandbox pod's image: joins with host/join, takes its sandbox's runs under the Environment's harness id, and runs bash on /workspace",
    section: "§9",
    class: "profile",
    needs: "pod",
  },
  {
    id: "HC16",
    title:
      "Serves the session's sandbox routes (workspace.exec, read, write), and they are refused 409 during a turn",
    section: "§10",
    class: "optional",
    needs: "workspace",
  },
  {
    id: "HC17",
    title:
      "Readies the session's MCP servers and calls their tools through the Tool Gate keyed by effect id: one tool.completed per call",
    section: "§5",
    class: "optional",
    needs: "mcp",
  },
  {
    id: "HC18",
    title:
      "With our harness connected too, each session runs on the harness it is pinned to and no other",
    section: "§2",
    class: "required",
  },
  {
    id: "HC19",
    title:
      "The log says who wrote what: the harness's reports are source harness with its id, evidence claimed and the run id; commands are the client's; each model call is metered once",
    section: "§4",
    class: "required",
  },
];

export const checkInfo = (id: string): CheckInfo => {
  const found = CHECKS.find((check) => check.id === id);
  if (!found) throw new Error(`Unknown check ${id}`);
  return found;
};
