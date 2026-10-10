import type { DaySummary, EventBlock, WeekSummary } from "../types";
import type { FixedCommitmentRow, ScheduledBlockRow } from "../../shared/db";
import {
  MONTH_SHORT,
  WEEKDAY_SHORT,
  longLabel,
  minutesOf,
  parseISODate,
  toISODate,
  trimTime,
} from "../../shared/datetime";
import { headlineForDay, headlineForWeek } from "./headline";

/** A block created this recently is annotated as "new" in the UI. */
const NEW_WINDOW_MINUTES = 5;

type BuildContext = {
  /** ISO date treated as today. */
  today: string;
  /** "HH:MM" treated as now. */
  now: string;
};

function statusOf(
  date: string,
  startTime: string,
  endTime: string,
  ctx: BuildContext,
): EventBlock["status"] {
  if (date < ctx.today) return "done";
  if (date > ctx.today) return "upcoming";
  const now = minutesOf(ctx.now);
  if (now >= minutesOf(endTime)) return "done";
  if (now >= minutesOf(startTime)) return "now";
  return "upcoming";
}

/** A block ending at midnight ("00:00") ends the day — render it as 24:00. */
const endOfDay = (time: string) => (time === "00:00" ? "24:00" : time);

/** scheduled_blocks row -> the shape the calendar components already render. */
export function blockToEvent(row: ScheduledBlockRow, ctx: BuildContext): EventBlock {
  const startTime = trimTime(row.start_time);
  const endTime = endOfDay(trimTime(row.end_time));
  const isNew =
    Date.now() - new Date(row.created_at).getTime() < NEW_WINDOW_MINUTES * 60_000 &&
    !row.previous_start_time;

  return {
    id: row.id,
    title: row.title,
    startTime,
    endTime,
    status: statusOf(row.date, startTime, endTime, ctx),
    kind: row.source_type,
    tag: row.previous_start_time ? "moved" : isNew ? "new" : undefined,
    movedFrom: row.previous_start_time ? trimTime(row.previous_start_time) : undefined,
    note: (row as unknown as { notes?: string | null }).notes ?? undefined,
  };
}

/** fixed_commitments row -> an EventBlock for a specific date. */
export function commitmentToEvent(
  row: FixedCommitmentRow,
  date: string,
  ctx: BuildContext,
): EventBlock {
  const startTime = trimTime(row.start_time);
  const endTime = endOfDay(trimTime(row.end_time));
  const color = (row as unknown as { color?: string | null }).color as EventBlock["color"] | undefined;
  const note = (row as unknown as { notes?: string | null }).notes ?? undefined;
  return {
    id: `${row.id}-${date}`,
    title: row.name,
    startTime,
    endTime,
    status: statusOf(date, startTime, endTime, ctx),
    kind: "fixed",
    color: color ?? undefined,
    note: note ?? undefined,
  };
}

export type ScheduleSource = {
  blocks: ScheduledBlockRow[];
  commitments: FixedCommitmentRow[];
};

export function isActive(date: string, c: FixedCommitmentRow): boolean {
  const from = (c as unknown as { active_from?: string | null }).active_from;
  const until = (c as unknown as { active_until?: string | null }).active_until;
  if (from && date < from) return false;
  if (until && date > until) return false;
  return true;
}

/** Everything on one date: fixed commitments for that weekday + scheduled blocks. */
export function buildDay(date: string, source: ScheduleSource, ctx: BuildContext): DaySummary {
  const weekday = parseISODate(date).getDay();
  const events = [
    ...source.commitments
      .filter((c) => c.days_of_week.includes(weekday) && isActive(date, c))
      .map((c) => commitmentToEvent(c, date, ctx)),
    ...source.blocks.filter((b) => b.date === date).map((b) => blockToEvent(b, ctx)),
  ].sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));

  const d = parseISODate(date);
  return {
    date,
    weekdayShort: WEEKDAY_SHORT[d.getDay()],
    dayOfMonth: String(d.getDate()),
    longLabel: longLabel(date),
    isToday: date === ctx.today,
    headline: headlineForDay(events, ctx.now),
    events,
  };
}

export function buildWeek(dates: string[], source: ScheduleSource, ctx: BuildContext): WeekSummary {
  const days = dates.map((date) => buildDay(date, source, ctx));
  return { headline: headlineForWeek(days), days };
}

/** "Aug 17 – Aug 23" for the week header. */
export function weekRangeLabel(dates: string[]): string {
  const first = parseISODate(dates[0]);
  const last = parseISODate(dates[dates.length - 1]);
  return `${MONTH_SHORT[first.getMonth()]} ${first.getDate()} – ${MONTH_SHORT[last.getMonth()]} ${last.getDate()} · ${last.getFullYear()}`;
}

export const todayISO = () => toISODate(new Date());
export const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
