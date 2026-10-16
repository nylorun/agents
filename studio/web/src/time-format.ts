import dayjs from "dayjs";

/**
 * A short time for a list or a message: the time alone today, the day and time this year, else
 * the date. `now` is for tests.
 */
export function shortTime(value: string, now: Date = new Date()): string {
  const at = dayjs(value);
  if (!at.isValid()) return "";
  const today = dayjs(now);
  if (at.isSame(today, "day")) return at.format("HH:mm");
  if (at.isSame(today, "year")) return at.format("MMM D, HH:mm");
  return at.format("MMM D, YYYY");
}

/** The full local time, for a tooltip. */
export function fullTime(value: string): string {
  const at = dayjs(value);
  return at.isValid() ? at.format("YYYY-MM-DD HH:mm:ss") : "";
}
