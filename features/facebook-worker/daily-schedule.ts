/** Calendar gates only new automatic cycles. In-flight cycles always finish. */
export type DailySchedule = { timeZone: "Europe/Warsaw"; times: string[] };

export function readDailySchedule(value: string | undefined): DailySchedule | null {
  if (value === undefined || value.trim() === "") return null; // Preserve existing interval installations.
  const times = value.split(",").map(time => time.trim());
  if (times.length < 1 || times.length > 24 || times.some(time => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) || new Set(times).size !== times.length) {
    throw new Error("INVALID_WATCHER_DAILY_SCAN_TIMES");
  }
  // Avoid ambiguous/nonexistent times during Polish daylight-saving transitions.
  if (times.some(time => time >= "02:00" && time < "03:00")) throw new Error("AMBIGUOUS_WATCHER_DAILY_SCAN_TIME");
  return { timeZone: "Europe/Warsaw", times: times.sort() };
}

const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function wallTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_SCHEDULE_DATE");
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function instant(local: string): number {
  // Warsaw is UTC+01/02. Round-trip against IANA data, never hardcode the current offset.
  const nominal = Date.parse(`${local}:00Z`);
  const candidates = [nominal - 3_600_000, nominal - 7_200_000].filter(ms => wallTime(new Date(ms)) === local);
  if (candidates.length !== 1) throw new Error("INVALID_LOCAL_SCHEDULE_TIME");
  return candidates[0];
}

export function dailyCycleDecision(schedule: DailySchedule, now: Date, lastCycleStartedAt: string | null): { due: boolean; slot: string | null; nextCycleAt: string } {
  const local = wallTime(now), day = local.slice(0, 10);
  const slots = schedule.times.map(time => instant(`${day}T${time}`));
  const dueSlot = slots.filter(ms => ms <= now.getTime()).at(-1);
  const lastStart = lastCycleStartedAt === null ? -Infinity : Date.parse(lastCycleStartedAt);
  if (Number.isNaN(lastStart)) throw new Error("INVALID_LAST_CYCLE_START");
  const due = dueSlot !== undefined && lastStart < dueSlot;
  const tomorrow = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const next = due ? dueSlot : slots.find(ms => ms > now.getTime()) ?? instant(`${tomorrow}T${schedule.times[0]}`);
  return { due, slot: dueSlot === undefined ? null : new Date(dueSlot).toISOString(), nextCycleAt: new Date(next!).toISOString() };
}
