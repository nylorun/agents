/** "Did you mean": the closest of `known` to `name`, when one is close enough to be a typo. */
export function suggestion(name: string, known: readonly string[]): string | undefined {
  let best: { value: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(candidate.length / 3)) && (!best || distance < best.distance))
      best = { value: candidate, distance };
  }
  return best?.value;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/**
 * Compares two strings with their runs of digits as numbers, so `2-style.md` comes before
 * `10-voice.md`. Equal numbers with different zero padding, and everything else, fall back to
 * UTF-16 order, so the order is total and the same on every platform.
 */
export function naturalCompare(a: string, b: string): number {
  const chunks = /(\d+|\D+)/g;
  const left = a.match(chunks) ?? [];
  const right = b.match(chunks) ?? [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index]!;
    const y = right[index]!;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const p = x.replace(/^0+(?=\d)/, "");
      const q = y.replace(/^0+(?=\d)/, "");
      if (p.length !== q.length) return p.length - q.length;
      if (p !== q) return p < q ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (left.length !== right.length) return left.length - right.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
