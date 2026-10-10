/** Date/time helpers shared by the client and the planner server. All times are local. */

/** Postgres returns "16:00:00"; the UI wants "16:00". */
export function trimTime(time: string): string {
  return time.slice(0, 5);
}

export function minutesOf(time: string): number {
  const [h, m] = trimTime(time).split(":").map(Number);
  return h * 60 + m;
}

export function timeOf(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/** "2026-08-20" for a local Date (never UTC-shifted, unlike toISOString). */
export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const date = parseISODate(iso);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

/** Monday of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const date = parseISODate(iso);
  const shift = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - shift);
  return toISODate(date);
}

/** The seven ISO dates Mon→Sun of the week containing `iso`. */
export function weekDates(iso: string): string[] {
  const monday = mondayOf(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Thursday · Aug 20 · 2026" */
export function longLabel(iso: string): string {
  const d = parseISODate(iso);
  return `${WEEKDAY_LONG[d.getDay()]} · ${MONTH_SHORT[d.getMonth()]} ${d.getDate()} · ${d.getFullYear()}`;
}

export function overlaps(
  a: { start_time: string; end_time: string },
  b: { start_time: string; end_time: string },
): boolean {
  return minutesOf(a.start_time) < minutesOf(b.end_time) && minutesOf(b.start_time) < minutesOf(a.end_time);
}
