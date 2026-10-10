export const SKILLS_USAGE =
  "The following skills provide specialized instructions. When a task matches a skill description, call load_skill with that name before proceeding.";

export function formatSkillCatalog(
  skills: readonly { name: string; description: string }[]
): string {
  const entries = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`
    )
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
