/**
 * Guards for Runtime response bodies the dashboard renders. A body missing a
 * list (`{}` from an older or misbehaving Runtime) becomes an error the view
 * shows, not a `.map` on undefined that takes the view down.
 */

/** `body[key]` when it is an array; otherwise throws `message`. */
export function listFrom<T>(body: unknown, key: string, message: string): T[] {
  const value =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[key]
      : undefined;
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

/** A readable message for anything a view threw. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error) return error;
  try {
    const text = JSON.stringify(error);
    if (text) return text;
  } catch {
    // Not serializable; fall through.
  }
  return String(error);
}
