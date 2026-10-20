/**
 * A trigger's `schedule` and `timezone`, checked with no clock and no Node API, so the CLI's
 * offline check, the compiler and the Runtime read them alike. The cron is five fields (minute,
 * hour, day of the month, month, day of the week), each `*`, a value, a range `a-b`, a step `/n`
 * on any of those, or a list of them; months and days of the week also take their three-letter
 * names (`JAN`, `MON`), in any case. Day 7 of the week is Sunday, as 0 is. The day of the month
 * also takes `L` (its last day), and the day of the week `5L` (the month's last Friday) and
 * `1#2` (its second Monday). `?` stands for `*` in either day field.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** The most days each month can have, for a day of the month no listed month reaches. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface CronField {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** The names that stand for `min`, `min + 1`, … */
  readonly names?: readonly string[];
}

const FIELDS: readonly CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day of the week", min: 0, max: 7, names: DAYS },
];

const DAY_OF_MONTH = 2;
const MONTH = 3;
const DAY_OF_WEEK = 4;

/** Why `schedule` is not a five-field cron, worded for a person; undefined when it is one. */
export function cronScheduleIssue(schedule: string): string | undefined {
  const parts = schedule.trim().split(/\s+/);
  if (schedule.trim() === "" || parts.length !== 5)
    return `schedule is five cron fields, minute hour day-of-month month day-of-week, such as "0 9 * * MON-FRI"; ${JSON.stringify(schedule)} has ${schedule.trim() === "" ? "none" : parts.length}`;
  const fields: ReadField[] = [];
  for (const [index, field] of FIELDS.entries()) {
    const read = readField(parts[index]!, index, field);
    if (typeof read === "string") return `schedule ${JSON.stringify(schedule)}: ${read}`;
    fields.push(read);
  }
  // A day of the month no listed month has never comes, unless a day of the week is listed too
  // (the cron then runs on either).
  const days = fields[DAY_OF_MONTH]!;
  const months = fields[MONTH]!;
  if (!days.every && !days.special && fields[DAY_OF_WEEK]!.every) {
    const longest = Math.max(...(months.every ? MONTH_DAYS : [...months.values].map((month) => MONTH_DAYS[month - 1]!)));
    const first = Math.min(...days.values);
    if (first > longest) return `schedule ${JSON.stringify(schedule)} never runs: no month it lists has day ${first}`;
  }
  return undefined;
}

/**
 * A field's values: `every` when it matches any value, `special` when it also names a day no list
 * of numbers shows (`L`, `5L`, `1#2`).
 */
interface ReadField {
  readonly values: ReadonlySet<number>;
  readonly every: boolean;
  readonly special: boolean;
}

/** What a field lists, or why it is not valid. */
function readField(text: string, index: number, field: CronField): ReadField | string {
  const values = new Set<number>();
  let every = false;
  let special = false;
  for (const item of text.split(",")) {
    if (item === "") return `the ${field.name} has an empty entry between commas`;
    if ((item === "?" || item === "*") && (item === "*" || index === DAY_OF_MONTH || index === DAY_OF_WEEK)) {
      every = true;
      continue;
    }
    if (index === DAY_OF_MONTH && item.toUpperCase() === "L") {
      special = true;
      continue;
    }
    if (index === DAY_OF_WEEK) {
      const last = /^(\w+)L$/i.exec(item);
      const nth = /^(\w+)#(\w+)$/.exec(item);
      if (last || nth) {
        const day = valueOf(last ? last[1]! : nth![1]!, field);
        if (typeof day === "string") return day;
        if (nth && !/^(?:[1-5]|L)$/i.test(nth[2]!))
          return `#${nth[2]} in ${item} is which ${DAYS[day % 7]} of the month: 1 to 5, or L for the last`;
        special = true;
        continue;
      }
    }
    const slash = item.split("/");
    if (slash.length > 2) return `${item} has two steps: write one, such as */15`;
    const [base, step] = slash as [string, string | undefined];
    if (step !== undefined && !/^\d+$/.test(step)) return `the step in ${item} is a whole number, such as */15`;
    if (step !== undefined && Number(step) === 0) return `the step in ${item} is 0: a step is 1 or more`;
    let from = field.min;
    let to = field.max;
    if (base !== "*" && !(base === "?" && (index === DAY_OF_MONTH || index === DAY_OF_WEEK))) {
      const range = base.split("-");
      if (range.length > 2 || range.some((part) => part === "")) return `${item} is not a value or a range of the ${field.name}, such as ${field.names ? `${field.names[1]}-${field.names[3]}` : `${field.min}-${field.min + 2}`}`;
      const low = valueOf(range[0]!, field);
      if (typeof low === "string") return low;
      const high = range.length === 2 ? valueOf(range[1]!, field) : step === undefined ? low : field.max;
      if (typeof high === "string") return high;
      if (low > high) return `the range ${base} runs backwards: write it from the lower value`;
      from = low;
      to = high;
    } else if (step === undefined) every = true;
    for (let value = from; value <= to; value += Number(step ?? 1)) values.add(value);
  }
  return { values, every, special };
}

/** The number a field's value stands for, or why it is none. */
function valueOf(text: string, field: CronField): number | string {
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (value < field.min || value > field.max) return `the ${field.name} is ${field.min}-${field.max}, and ${text} is not`;
    return value;
  }
  const names = field.names;
  const at = names?.indexOf(text.toUpperCase()) ?? -1;
  if (names && at >= 0) return field.min + at;
  const close = names?.find((name) => text.toUpperCase().startsWith(name));
  return `${JSON.stringify(text)} is not a ${field.name}: write ${field.min}-${field.max}${names ? ` or ${names[0]}-${names.at(-1)}` : ""}${close ? `. Did you mean ${close}?` : ""}`;
}

/** Whether `zone` is a time zone this platform knows: an IANA name, such as `Asia/Kolkata`. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Current IANA names that platforms list under an older one (`Intl.supportedValuesOf` gives
 * `Asia/Calcutta`), so a "did you mean" offers the name people write today.
 */
const CURRENT_ZONE_NAMES = [
  "Asia/Kolkata",
  "Asia/Ho_Chi_Minh",
  "Asia/Kathmandu",
  "Asia/Yangon",
  "Europe/Kyiv",
  "America/Argentina/Buenos_Aires",
  "America/Nuuk",
  "Atlantic/Faroe",
  "Pacific/Chuuk",
  "Pacific/Pohnpei",
];

/** The IANA time zones this platform knows, for a "did you mean"; empty where it cannot list them. */
export function timeZoneNames(): readonly string[] {
  if (typeof Intl.supportedValuesOf !== "function") return [];
  return [...CURRENT_ZONE_NAMES.filter(isTimeZone), ...Intl.supportedValuesOf("timeZone")];
}
