/**
 * Strict JSON (RFC 8259) with positions, for an agent folder's JSON files: no comments, no
 * trailing commas, and a key twice in one object is an error. Each value and object key is
 * found by its JSON pointer, so a diagnostic names the line and column of what it is about.
 */

/** A 1-based line and column. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Where a parsed value starts, and for an object member where its key starts. */
export interface Located {
  readonly value: Position;
  readonly key?: Position;
}

export type ParsedJson =
  | { readonly ok: true; readonly value: unknown; readonly positions: ReadonlyMap<string, Located> }
  | { readonly ok: false; readonly message: string; readonly at: Position };

/** The pointer of `path` (RFC 6901): `""` for the whole document. */
export function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

class JsonError extends Error {
  constructor(
    message: string,
    readonly at: Position,
  ) {
    super(message);
  }
}

/** Parses `text` as strict JSON, keeping the position of every value and key. */
export function parseJson(text: string): ParsedJson {
  const positions = new Map<string, Located>();
  let index = 0;
  let line = 1;
  let lineStart = 0;
  const here = (): Position => ({ line, column: index - lineStart + 1 });
  const fail = (message: string, at: Position = here()): never => {
    throw new JsonError(message, at);
  };
  const space = () => {
    for (;;) {
      const char = text[index];
      if (char === "\n") {
        index++;
        line++;
        lineStart = index;
      } else if (char === " " || char === "\t" || char === "\r") index++;
      else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*"))
        fail("Comments are not JSON: explain a value in its description field, or in README.md");
      else return;
    }
  };
  const literal = (word: string, value: unknown) => {
    if (text.startsWith(word, index)) {
      index += word.length;
      return value;
    }
    return fail(`Unexpected ${describe(text[index])}`);
  };
  const string = (): string => {
    let out = "";
    index++; // the opening quote
    for (;;) {
      const char = text[index];
      if (char === undefined) fail("A string is not closed");
      if (char === '"') {
        index++;
        return out;
      }
      if (char === "\n" || char < " ") fail("A string holds a control character; write it as an escape such as \\n");
      if (char !== "\\") {
        out += char;
        index++;
        continue;
      }
      const escape = text[index + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escape !== undefined && escape in simple) {
        out += simple[escape];
        index += 2;
      } else if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        out += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
        index += 6;
      } else fail(`Unknown escape \\${escape ?? ""}`);
    }
  };
  const number = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) return fail(`Unexpected ${describe(text[index])}`);
    index += match[0].length;
    return Number(match[0]);
  };
  const value = (path: readonly PropertyKey[], key?: Position): unknown => {
    space();
    const start = here();
    positions.set(pointerOf(path), key ? { value: start, key } : { value: start });
    const char = text[index];
    if (char === "{") {
      index++;
      const object: Record<string, unknown> = {};
      space();
      if (text[index] === "}") {
        index++;
        return object;
      }
      for (;;) {
        space();
        if (text[index] !== '"') fail(text[index] === "}" ? "A trailing comma is not JSON" : "An object's key is a string in double quotes");
        const keyAt = here();
        const name = string();
        if (Object.hasOwn(object, name)) fail(`The key "${name}" appears twice in one object`, keyAt);
        space();
        if (text[index] !== ":") fail(`Expected : after the key "${name}"`);
        index++;
        object[name] = value([...path, name], keyAt);
        space();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "}") {
          index++;
          return object;
        }
        fail(`Expected , or } after the value of "${name}"`);
      }
    }
    if (char === "[") {
      index++;
      const array: unknown[] = [];
      space();
      if (text[index] === "]") {
        index++;
        return array;
      }
      for (;;) {
        array.push(value([...path, array.length]));
        space();
        if (text[index] === ",") {
          index++;
          space();
          if (text[index] === "]") fail("A trailing comma is not JSON");
          continue;
        }
        if (text[index] === "]") {
          index++;
          return array;
        }
        fail("Expected , or ] in an array");
      }
    }
    if (char === '"') return string();
    if (char === "t") return literal("true", true);
    if (char === "f") return literal("false", false);
    if (char === "n") return literal("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return number();
    return fail(char === undefined ? "The file ends before a value" : `Unexpected ${describe(char)}`);
  };
  try {
    const parsed = value([]);
    space();
    if (index < text.length) fail(`Unexpected ${describe(text[index])} after the value`);
    return { ok: true, value: parsed, positions };
  } catch (error) {
    if (error instanceof JsonError) return { ok: false, message: error.message, at: error.at };
    throw error;
  }
}

function describe(char: string | undefined): string {
  if (char === undefined) return "end of file";
  if (char === "'") return "' (JSON strings use double quotes)";
  return JSON.stringify(char);
}
