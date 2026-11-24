/**
 * Skills only a person starts (Host feature `person-started-skills`): a skill with
 * `disableModelInvocation: true` is left out of what the model sees (its catalog, `load_skill`'s
 * names and what `load_skill` serves) unless the turn's input names it in `metadata.skill`, which
 * the Runtime sets from the message's `skill`. An agent used as a tool never gets one: a person
 * starts a skill for the root agent's turn.
 */
import type { AgentManifest } from "@nylorun/core/define";

const NONE: ReadonlySet<string> = new Set();

/** The skills a person started for a turn: `metadata.skill` of its input, or of each queued message. */
export function startedSkillsOf(input: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  const read = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const item = value as { kind?: unknown; messages?: unknown; metadata?: { skill?: unknown } };
    if (item.kind === "messages" && Array.isArray(item.messages)) {
      for (const message of item.messages) read(message);
      return;
    }
    if (typeof item.metadata?.skill === "string") names.add(item.metadata.skill);
  };
  read(input);
  return names.size === 0 ? NONE : names;
}

/** The agent as its model sees it: each skill only a person starts left out unless `started` names it. */
export function withPersonStartedSkills<T extends Pick<AgentManifest, "skills">>(agent: T, started: ReadonlySet<string> = NONE): T {
  const skills = agent.skills;
  if (!skills) return agent;
  const shown = (skill: NonNullable<AgentManifest["skills"]>[string]) => skill.disableModelInvocation !== true || started.has(skill.name);
  if (Object.values(skills).every(shown)) return agent;
  const kept = Object.fromEntries(Object.entries(skills).filter(([, skill]) => shown(skill)));
  const { skills: _, ...rest } = agent;
  return (Object.keys(kept).length === 0 ? rest : { ...rest, skills: kept }) as T;
}
