import { http } from "@nylorun/agents";
import { tool } from "@nylorun/agents/define";
import { z } from "zod";
import { TOOLS_URL } from "../shared/tools/service.js";

export const Brief = z.object({ title: z.string(), markdown: z.string() });
const Published = z.object({ id: z.string(), title: z.string(), words: z.number() });
const description = "Publish a checked repo brief.";

/** What the tools service has published, oldest first. It stands in for your CMS. */
export const publishedBriefs: (z.infer<typeof Brief> & { id: string })[] = [];

/** The publish step's code, which the tools service runs (`POST /publish_brief`). */
export const publishBriefCode = tool({
  name: "publish_brief",
  description,
  input: Brief,
  output: Published,
  async run(brief) {
    const id = `brief-${publishedBriefs.length + 1}`;
    publishedBriefs.push({ id, ...brief });
    return { id, title: brief.title, words: brief.markdown.split(/\s+/).filter(Boolean).length };
  },
});

/**
 * The flow's last stage, an HTTP tool: the Runtime POSTs the writer's `{ title, markdown }` to
 * `<url>/publish_brief` (default TOOLS_URL, the tools service) and the answer is the flow's output.
 */
export function publishBrief(url: string = TOOLS_URL) {
  return http({
    name: "publish_brief",
    description,
    input: Brief,
    output: Published,
    url: `${url.replace(/\/$/, "")}/publish_brief`,
  });
}
