/**
 * Pages of UTF-8 text for `read_artifact`: a page is whole characters, and at most a set number
 * of bytes once escaped as JSON, since the model reads it inside a JSON tool result.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The bytes of `value` as JSON. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
}

/**
 * The nearest position at or around `at` that is not inside a UTF-8 character: moving `down`
 * (towards the start) or `up` (towards the end).
 */
export function utf8Boundary(bytes: Uint8Array, at: number, direction: "down" | "up"): number {
  let position = Math.max(0, Math.min(at, bytes.byteLength));
  const inside = (index: number) => index < bytes.byteLength && (bytes[index]! & 0xc0) === 0x80;
  if (direction === "down") while (position > 0 && inside(position)) position -= 1;
  else while (inside(position)) position += 1;
  return position;
}

/** Where the last whole character of `bytes` ends: before a character its end cuts off. */
function wholeEnd(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  const lead = utf8Boundary(bytes, bytes.byteLength - 1, "down");
  const first = bytes[lead]!;
  const length = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return lead + length > bytes.byteLength ? lead : bytes.byteLength;
}

/**
 * The text of a page of UTF-8 `bytes` in whole characters, at most `maxBytes` once escaped as
 * JSON, and how many bytes it used: the next page starts there. A page that starts inside a
 * character skips its rest, and one that ends inside one (not `last`) stops before it.
 */
export function textPage(
  bytes: Uint8Array,
  last: boolean,
  maxBytes: number,
): { text: string; bytes: number } {
  const from = utf8Boundary(bytes, 0, "up");
  let to = last ? bytes.byteLength : wholeEnd(bytes);
  // A page shorter than one character: take what there is.
  if (to <= from) to = bytes.byteLength;
  const decode = (end: number) => decoder.decode(bytes.subarray(from, end));
  const text = decode(to);
  if (jsonBytes(text) <= maxBytes) return { text, bytes: to };
  // Escaped (quotes, newlines, control characters), text takes more room than its bytes: the page
  // ends at the last character boundary whose text still fits, found by halving.
  const fits = (end: number) => jsonBytes(decode(end)) <= maxBytes;
  let low = from;
  let high = to;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(utf8Boundary(bytes, middle, "down"))) low = middle;
    else high = middle;
  }
  const end = Math.max(from, utf8Boundary(bytes, low, "down"));
  return { text: decode(end), bytes: end };
}
