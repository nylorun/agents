/**
 * DESIGN.md's status dots: three greys, no color. The darker the dot, the more it needs you; the
 * word beside it carries the meaning.
 */
export const STATUS_DOT = {
  /** Failed, or waiting on a person. */
  attention: "bg-foreground",
  /** Running or healthy. */
  running: "bg-muted-foreground",
  /** Idle or stopped. */
  idle: "bg-ring",
} as const;

/** A count of things waiting on a person: a zinc badge, never a colored one. */
export const COUNT_BADGE = "bg-primary text-primary-foreground";
