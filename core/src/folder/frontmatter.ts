/**
 * A Markdown file's frontmatter, as an agent folder reads it: YAML 1.2 under the core schema,
 * with no anchors, aliases, tags or merge keys, and a key twice in one map an error. It holds a
 * few settings, so the restriction costs authors nothing, and it rules out alias bombs and
 * YAML 1.1's surprises. Each value and key is found by its JSON pointer, with its line and column
 * in the whole file.
 */
import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Node } from "yaml";
import { pointerOf, type Located, type Position } from "./json.js";

export type ParsedMarkdown =
  | {
      readonly ok: true;
      /** The frontmatter as plain data: `{}` when the file has none. */
      readonly data: Record<string, unknown>;
      /** Whether the file opened with a frontmatter block. */
      readonly hasFrontmatter: boolean;
      readonly body: string;
      /** The line the body starts on. */
      readonly bodyLine: number;
      readonly positions: ReadonlyMap<string, Located>;
    }
  | { readonly ok: false; readonly message: string; readonly at: Position };

const FENCE = /^---[ \t]*$/;

/**
 * Splits `text` into its frontmatter and body, and parses the frontmatter. CRLF line ends (a
 * Windows checkout) are read as LF first, so lines and columns are the same either way.
 */
export function parseMarkdown(source: string): ParsedMarkdown {
  const text = source.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (!FENCE.test(lines[0] ?? ""))
    return { ok: true, data: {}, hasFrontmatter: false, body: text, bodyLine: 1, positions: new Map() };
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (end < 0) return { ok: false, message: "The frontmatter opened with --- is not closed by a line of ---", at: { line: 1, column: 1 } };
  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  // Positions in the YAML count from the line after the opening fence.
  const shift = (position: { line: number; col: number }): Position => ({ line: position.line + 1, column: position.col });
  const counter = new LineCounter();
  const document = parseDocument(yamlText, {
    lineCounter: counter,
    schema: "core",
    version: "1.2",
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
  });
  const at = (node: { range?: readonly number[] | null | undefined } | null | undefined): Position =>
    shift(counter.linePos(node?.range?.[0] ?? 0));
  const first = document.errors[0];
  if (first) {
    const position = first.linePos?.[0] ? shift(first.linePos[0]) : { line: 2, column: 1 };
    const raw = first.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
    const alias = first.code === "BAD_ALIAS" || /alias/i.test(raw);
    const message =
      first.code === "DUPLICATE_KEY"
        ? "A key appears twice in the frontmatter"
        : alias
          ? `${raw}: a value that starts with * or & must be quoted, such as schedule: "0 2 * * *"`
          : raw;
    return { ok: false, message: `The frontmatter is not valid YAML: ${message}`, at: position };
  }
  let refusal: { message: string; at: Position } | undefined;
  visit(document, {
    Alias(_, node) {
      refusal ??= { message: "Frontmatter takes no aliases (*name): write the value out", at: at(node) };
      return visit.BREAK;
    },
    Node(_, node) {
      if (node.anchor) refusal ??= { message: "Frontmatter takes no anchors (&name)", at: at(node) };
      else if (node.tag) refusal ??= { message: `Frontmatter takes no tags (${node.tag})`, at: at(node) };
      return refusal ? visit.BREAK : undefined;
    },
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<")
        refusal ??= { message: "Frontmatter takes no merge keys (<<)", at: at(pair.key) };
      return refusal ? visit.BREAK : undefined;
    },
  });
  if (refusal) return { ok: false, ...refusal };
  const contents = document.contents;
  if (contents !== null && !isMap(contents))
    return { ok: false, message: "The frontmatter is a map of keys to values", at: at(contents) };
  const positions = new Map<string, Located>();
  const walk = (node: unknown, path: PropertyKey[], key?: Position) => {
    if (node === null || node === undefined || isAlias(node)) return;
    positions.set(pointerOf(path), key ? { value: at(node as Node), key } : { value: at(node as Node) });
    if (isMap(node))
      for (const item of node.items) {
        if (!isPair(item) || !isScalar(item.key)) continue;
        const name = String(item.key.value);
        walk(item.value ?? item.key, [...path, name], at(item.key));
      }
    else if (isSeq(node)) node.items.forEach((item, index) => walk(item, [...path, index]));
  };
  walk(contents, []);
  const data = (contents === null ? {} : document.toJS({ maxAliasCount: 0 })) as Record<string, unknown>;
  return { ok: true, data: data ?? {}, hasFrontmatter: true, body, bodyLine: end + 2, positions };
}
