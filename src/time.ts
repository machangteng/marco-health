const SHANGHAI = "Asia/Shanghai";
const OFFSET_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO-8601 with a timezone, the only timestamp form this service stores. */
export function parseOffsetDateTime(value: string): Date | null {
  if (!OFFSET_DATE_TIME.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** Calendar day of an instant in Asia/Shanghai (YYYY-MM-DD). */
export function shanghaiDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function shiftShanghaiDay(day: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error("shiftShanghaiDay requires YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, dayOfMonth + deltaDays));
  return utc.toISOString().slice(0, 10);
}

/** Idempotency instant for a Shanghai calendar day: that day at 00:00:00+08:00. */
export function shanghaiDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

export function formatInShanghai(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const hour = read("hour") === "24" ? "00" : read("hour");
  return `${read("year")}-${read("month")}-${read("day")}T${hour}:${read("minute")}:${read("second")}+08:00`;
}

export function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

/** Unix seconds or milliseconds → epoch milliseconds. Rejects date-shaped small numbers. */
export function epochMillis(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value > 1e12) return Math.trunc(value);
  if (value > 1e9) return Math.trunc(value * 1000);
  return null;
}

/** Most recent complete Asia/Shanghai calendar day. */
export function lastCompleteShanghaiDay(now: Date): string {
  return shiftShanghaiDay(shanghaiDay(now), -1);
}
