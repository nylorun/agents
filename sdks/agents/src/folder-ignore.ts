/**
 * `.nyloignore` (track T7): the files `packFolder` leaves out of an agent folder, in gitignore
 * syntax. Blank lines and `#` comments are skipped; `!` re-includes what an earlier line left out;
 * a trailing `/` matches directories only; a pattern with a `/` before its end is anchored at the
 * folder, and one without matches a name at any depth; `*`, `?`, `[…]` and `**` glob as in git.
 * The last line that matches decides, and nothing below a directory left out comes back, as in
 * git. Pure: no Node module, so it also reads a project's `.gitignore`.
 */

/** One line of an ignore file. */
interface IgnoreRule {
  readonly negate: boolean;
  readonly directoryOnly: boolean;
  readonly pattern: RegExp;
}

/** A glob's body as a regular expression's source: `*` and `?` stop at `/`, `**` crosses it. */
function globSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "\\" && index + 1 < glob.length) {
      source += escapeChar(glob[++index]!);
      continue;
    }
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const before = index === 0 || glob[index - 1] === "/";
        const after = index + 2 === glob.length || glob[index + 2] === "/";
        if (before && after) {
          if (index + 2 === glob.length) source += ".*"; // `a/**`: everything inside
          else {
            source += "(?:.*/)?"; // `**/` and `/**/`: zero or more directories
            index += 1; // the `/` after `**`
          }
          index += 1;
          continue;
        }
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = glob.indexOf("]", index + 2);
      if (end > 0) {
        let body = glob.slice(index + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        index = end;
        continue;
      }
    }
    source += escapeChar(char);
  }
  return source;
}

const escapeChar = (char: string) => char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The rules of an ignore file's text. */
function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Trailing spaces go, unless the last is escaped.
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    if (line === "") continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = globSource(line);
    rules.push({
      negate,
      directoryOnly,
      pattern: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`),
    });
  }
  return rules;
}

/**
 * A matcher for an ignore file's text: whether `path` (relative, `/` between segments) is left
 * out, a directory when `directory` is true. A path below a directory left out is left out too.
 */
export function ignoreMatcher(text: string): (path: string, directory?: boolean) => boolean {
  const rules = parseIgnore(text);
  const decide = (path: string, directory: boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !directory) continue;
      if (rule.negate === ignored && rule.pattern.test(path)) ignored = !rule.negate;
    }
    return ignored;
  };
  return (path, directory = false) => {
    if (rules.length === 0) return false;
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1)
      if (decide(segments.slice(0, depth).join("/"), true)) return true;
    return decide(path, directory);
  };
}
