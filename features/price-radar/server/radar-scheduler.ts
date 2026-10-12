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

/** True once the saved Warsaw wall-clock time has arrived, unless today's run already started. */
export function isRadarDailyScanDue(input: { enabled: boolean; time: string; lastStartedAt?: string | null }, now: Date = new Date()): boolean {
  if (!input.enabled || !/^[0-9]{2}:[0-9]{2}$/u.test(input.time)) return false;
  const [hours, minutes] = input.time.split(":").map(Number);
  if (hours > 23 || minutes > 59 || !Number.isFinite(now.getTime())) return false;
  if (input.lastStartedAt && radarRunStartedTodayInWarsaw(input.lastStartedAt, now)) return false;
  const local = warsawClockParts(now);
  return local !== null && local.hour * 60 + local.minute >= hours * 60 + minutes;
}

/** Next daily wall-clock occurrence in Europe/Warsaw; null when automation is off/invalid. */
export function nextRadarDailyScanAt(input: { enabled: boolean; time: string; lastStartedAt?: string | null }, now: Date = new Date()): Date | null {
  if (!input.enabled || !/^[0-9]{2}:[0-9]{2}$/u.test(input.time)) return null;
  const [hours, minutes] = input.time.split(":").map(Number);
  if (hours > 23 || minutes > 59 || !Number.isFinite(now.getTime())) return null;
  const today = warsawDateKey(now);
  if (!today) return null;
  const lastRunToday = Boolean(input.lastStartedAt && radarRunStartedTodayInWarsaw(input.lastStartedAt, now));
  for (let offset = 0; offset < 9; offset += 1) {
    const date = addCalendarDays(today, offset);
    if (date === today && lastRunToday) continue;
    const occurrence = localTimeInstants(date, hours, minutes)[0] ?? firstValidMinuteAfter(date, hours, minutes);
    if (!occurrence) continue;
    if (occurrence.getTime() <= now.getTime()) {
      if (date === today && !lastRunToday) return now;
      continue;
    }
    return occurrence;
  }
  return null;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function warsawClockParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const values = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const field = (type: string) => Number(values.find((part) => part.type === type)?.value);
  const parts = { year: field("year"), month: field("month"), day: field("day"), hour: field("hour"), minute: field("minute") };
  return Object.values(parts).every(Number.isFinite) ? parts : null;
}

function localTimeInstants(date: string, hour: number, minute: number): Date[] {
  const [year, month, day] = date.split("-").map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (let hoursAround = -36; hoursAround <= 36; hoursAround += 6) {
    const sample = new Date(wallTime + hoursAround * 60 * 60_000);
    const local = warsawClockParts(sample);
    if (local) offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample.getTime());
  }
  return [...offsets].map((offset) => new Date(wallTime - offset))
    .filter((candidate) => {
      const local = warsawClockParts(candidate);
      return local !== null && warsawDateKey(candidate) === date && local.hour === hour && local.minute === minute;
    })
    .sort((a, b) => a.getTime() - b.getTime());
}

function firstValidMinuteAfter(date: string, hour: number, minute: number): Date | null {
  const startingMinute = hour * 60 + minute;
  for (let delta = 1; delta <= 180; delta += 1) {
    const total = startingMinute + delta;
    if (total >= 24 * 60) return null;
    const found = localTimeInstants(date, Math.floor(total / 60), total % 60)[0];
    if (found) return found;
  }
  return null;
}
