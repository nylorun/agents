import { projectAsset } from "@nylorun/runtime/node";
import { Agent, VerdictSchema } from "@nylorun/agents";
import { z } from "zod";
import { DEEPWIKI_MCP_URL } from "../mcp/agent.js";
import { EXAMPLES_ROOT } from "../shared/root.js";
import { tools as clock } from "../shared/tools/catalog/now.js";
import { serviced, TOOLS_URL } from "../shared/tools/service.js";
import { Brief, publishBrief } from "./publish.js";

/** The `repo-brief` skill: SKILL.md and the check script the writer runs in the sandbox. */
export const REPO_BRIEF_SKILLS = projectAsset("agents/repo-brief/skills", EXAMPLES_ROOT);

/** Where the brief's services live: the tools service and the MCP server the researcher asks. */
export type RepoBriefServices = Readonly<{ toolsUrl?: string; mcpUrl?: string }>;

/**
 * Every manifest-only piece in one flow agent (track R2): ask it to brief you on a public
 * GitHub repository, named as owner/repo.
 *
 *   triage → switch ┬ repo:    map(researcher) → parallel(overview, risks) → loop(writer, editor) → publish_brief
 *                   └ default: decline
 *
 * The researcher asks DeepWiki's remote MCP server, once per question. The writer follows the
 * `repo-brief` skill: it writes the brief in the session's sandbox, runs the skill's check
 * script there, and dates the brief with the `now` HTTP tool. The editor verifies each draft,
 * and the last stage is the `publish_brief` HTTP tool. The Runtime runs all of it from the
 * manifest: no code of this project runs during a session, so open the session with a
 * sandbox (`sandbox: {}`, or the Tenant's default) for the writer's shell.
 * Design: docs/design/agent/flow-agents.md
 */
export function createRepoBrief({ toolsUrl = TOOLS_URL, mcpUrl = DEEPWIKI_MCP_URL }: RepoBriefServices = {}) {
  const triage = Agent({
    id: "triage",
    name: "Triage",
    description: "Finds the repository a request names and the questions to research.",
  })
    .instructions(
      "Decide whether the request names a public GitHub repository as owner/repo. If it does, return route repo, the repository, and three short questions a new contributor would ask about it as items. Otherwise return route other, an empty repo and no items.",
    )
    .output(z.object({ route: z.enum(["repo", "other"]), repo: z.string(), items: z.array(z.string()) }));

  const researcher = Agent({
    id: "researcher",
    name: "Researcher",
    description: "Answers one question about a repository through DeepWiki.",
  })
    .instructions(
      "You get one question about the repository named in the original request. Ask it with the deepwiki ask_question tool, naming the repository as owner/repo. Return the question and a short answer drawn only from what deepwiki said.",
    )
    .mcp({ deepwiki: { type: "streamable-http", url: mcpUrl } })
    .output(z.object({ question: z.string(), answer: z.string() }));

  const overview = Agent({
    id: "overview",
    name: "Overview",
    description: "Summarizes the research.",
  })
    .instructions(
      "You get the research, one answer per question. Summarize what the repository is for in two or three sentences, and restate each answer as one concrete finding.",
    )
    .output(z.object({ summary: z.string(), findings: z.array(z.string()) }));

  const risks = Agent({
    id: "risks",
    name: "Risk reviewer",
    description: "Lists the risks the research shows.",
  })
    .instructions("You get the research, one answer per question. List up to three risks a team adopting the repository should know about.")
    .output(z.object({ risks: z.array(z.string()) }));

  const writer = Agent({
    id: "writer",
    name: "Brief writer",
    description: "Writes and checks the brief.",
  })
    .instructions(
      "Write the repo brief from the overview and the risks. Load the repo-brief skill and follow it, and date the brief with the now tool. Return the title and the Markdown that passed the check. When you get feedback, fix the brief and check it again.",
    )
    .skills(REPO_BRIEF_SKILLS, { id: "skills" })
    .tools(...clock.map((tool) => serviced(tool, toolsUrl)))
    .output(Brief);

  const editor = Agent({
    id: "editor",
    name: "Editor",
    description: "Checks a draft brief.",
  })
    .instructions(
      "You check a repo brief. Pass it when its findings are concrete statements and its risks follow from them; otherwise say what to fix.",
    )
    .output(VerdictSchema);

  const decline = Agent({
    id: "decline",
    name: "Decline",
    description: "Answers requests that name no repository.",
  }).instructions("You brief public GitHub repositories. Say so in one sentence and ask which repository, as owner/repo.");

  const research = Agent({ id: "research", name: "Research" })
    .map(researcher, { id: "ask" })
    .parallel({ overview, risks }, { id: "review" })
    .loop(writer, { verify: editor, max: 2, id: "draft" })
    .pipe(publishBrief(toolsUrl));

  return Agent({
    id: "repo-brief",
    name: "Repo brief",
    description: "Researches a public GitHub repository through DeepWiki, then writes, checks and publishes a brief.",
  })
    .pipe(triage)
    .switch({ repo: research, default: decline }, { id: "route" })
    .build();
}
