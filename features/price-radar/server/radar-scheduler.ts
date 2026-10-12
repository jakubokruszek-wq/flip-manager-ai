/** Stable Warsaw calendar key for the daily scheduler's idempotency guard. */
export function warsawDateKey(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const field = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = field("year");
  const month = field("month");
  const day = field("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function radarRunStartedTodayInWarsaw(startedAt: string, now: Date = new Date()): boolean {
  const runDate = warsawDateKey(startedAt);
  return runDate !== null && runDate === warsawDateKey(now);
}
