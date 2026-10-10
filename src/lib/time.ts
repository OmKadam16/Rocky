/** Shared time-axis math for the Day and Week grids. */

/** First hour rendered on the axis. */
export const DAY_START_HOUR = 5;
/** Axis runs to midnight so late blocks (e.g. 23:59–24:00) stay in-grid. */
export const DAY_END_HOUR = 24;

/** Day view: 64px per hour, so a 15-min block and a 90-min block read differently. */
export const DAY_PX_PER_HOUR = 64;
/** Shortest block the day grid will draw, so a 15-min event stays readable. */
export const DAY_MIN_BLOCK_HEIGHT = 22;
/** Week view: tighter than the day axis, still proportional. */
export const WEEK_PX_PER_HOUR = 44;
export const WEEK_MIN_BLOCK_HEIGHT = 18;

export const HOUR_COUNT = DAY_END_HOUR - DAY_START_HOUR;
export const DAY_AXIS_HEIGHT = HOUR_COUNT * DAY_PX_PER_HOUR;
export const WEEK_AXIS_HEIGHT = HOUR_COUNT * WEEK_PX_PER_HOUR;

/** "05:00", "06:00", … "23:00", then midnight as "00:00". */
export const HOUR_LABELS = [
  ...Array.from(
    { length: HOUR_COUNT },
    (_, i) => `${String(DAY_START_HOUR + i).padStart(2, "0")}:00`,
  ),
  "00:00",
];

/** "16:30" -> 990 */
export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** 990 -> "16:30" */
export function toTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes from the top of the axis. */
export function minutesFromStart(time: string): number {
  return toMinutes(time) - DAY_START_HOUR * 60;
}

export function durationMinutes(event: { startTime: string; endTime: string }): number {
  return toMinutes(event.endTime) - toMinutes(event.startTime);
}

/** Vertical offset, in px, of a time on an axis of the given scale. */
export function offsetAt(time: string, pxPerHour: number): number {
  return (minutesFromStart(time) / 60) * pxPerHour;
}

/** Height, in px, of an event — proportional to its duration. */
export function heightOf(
  event: { startTime: string; endTime: string },
  pxPerHour: number,
  minHeight: number,
): number {
  return Math.max(minHeight, (durationMinutes(event) / 60) * pxPerHour);
}

export const dayOffset = (time: string) => offsetAt(time, DAY_PX_PER_HOUR);
export const dayHeight = (event: { startTime: string; endTime: string }) =>
  heightOf(event, DAY_PX_PER_HOUR, DAY_MIN_BLOCK_HEIGHT);
export const weekOffset = (time: string) => offsetAt(time, WEEK_PX_PER_HOUR);
export const weekHeight = (event: { startTime: string; endTime: string }) =>
  heightOf(event, WEEK_PX_PER_HOUR, WEEK_MIN_BLOCK_HEIGHT);

/** 285 -> "4 hr 45 min", 60 -> "1 hr", 45 -> "45 min" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

export type Gap = { id: string; startTime: string; endTime: string; label: string };

/** Open stretches between events, long enough to be worth labelling. */
export function findGaps(
  events: { id: string; startTime: string; endTime: string }[],
  minMinutes = 60,
): Gap[] {
  const sorted = [...events].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const gaps: Gap[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const end = toMinutes(sorted[i].endTime);
    const next = toMinutes(sorted[i + 1].startTime);
    const span = next - end;
    if (span >= minMinutes) {
      gaps.push({
        id: `gap-${sorted[i].id}`,
        startTime: toTimeString(end),
        endTime: toTimeString(next),
        label: `${formatDuration(span)} open`,
      });
    }
  }
  return gaps;
}

/** "10:03" -> "ends in 12 min" for the NOW row. */
export function endsIn(now: string, endTime: string): string {
  const left = toMinutes(endTime) - toMinutes(now);
  return left > 0 ? `ends in ${formatDuration(left)}` : "wrapping up";
}
