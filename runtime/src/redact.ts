export interface ScrubOptions {
  /**
   * Replace only `secrets` (R2b C8, Q16): no value under a secret-looking key, and no inline
   * image data. A tool's answer keeps fields such as `nextToken`.
   */
  readonly valuesOnly?: boolean;
  /** Told how many times a secret was replaced. */
  readonly counted?: (replacements: number) => void;
}

/**
 * `value` with each of `secrets` (those of at least 8 characters) replaced by `[redacted]`. By
 * default also any value under a key such as `token` or `secret`, and inline image data.
 */
export function scrub(value: unknown, secrets: readonly string[], options: ScrubOptions = {}): unknown {
  // The longest first, so a header value goes whole before the token inside it.
  const sorted = secrets.filter((secret) => secret.length >= 8).sort((a, b) => b.length - a.length);
  let replaced = 0;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      const text = options.valuesOnly
        ? item
        : item.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu, "[inline image data redacted]");
      return sorted.reduce((current, secret) => {
        const parts = current.split(secret);
        replaced += parts.length - 1;
        return parts.join("[redacted]");
      }, text);
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, entry]) => [
          key,
          !options.valuesOnly &&
          /^(authorization|api[_-]?key|(?:access|refresh|id|auth)[_-]?token|token|secret|password|cookie|credentials?)$/iu.test(
            key,
          )
            ? "[redacted]"
            : walk(entry),
        ]),
      );
    return item;
  };
  const result = walk(value);
  options.counted?.(replaced);
  return result;
}

/** `value` with `secrets` alone replaced (`valuesOnly`), and how many replacements were made. */
export function scrubValues<T>(value: T, secrets: readonly string[]): { value: T; redacted: number } {
  if (secrets.length === 0) return { value, redacted: 0 };
  let redacted = 0;
  const scrubbed = scrub(value, secrets, { valuesOnly: true, counted: (count) => (redacted = count) });
  return { value: redacted === 0 ? value : (scrubbed as T), redacted };
}
