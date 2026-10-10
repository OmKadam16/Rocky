import type { DaySummary, EventBlock } from "../types";
import { WEEKDAY_LONG, minutesOf, parseISODate, timeOf } from "../../shared/datetime";
import { DAY_END_HOUR, durationMinutes } from "./time";

/**
 * The editorial sentence at the top of each view. Generated from the schedule
 * rather than written by the model — it has to be instant and never surprising.
 */

const NUMBER_WORDS = [
  "Nothing", "One thing", "Two things", "Three things", "Four things", "Five things",
  "Six things", "Seven things", "Eight things", "Nine things", "Ten things",
];

const HOUR_WORDS = [
  "midnight", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "noon",
];

/** 14:00 -> "two", 14:30 -> "half past two" */
function spokenTime(time: string): string {
  const total = minutesOf(time);
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;
  const hour = hour24 === 12 ? 12 : hour24 % 12;
  const word = HOUR_WORDS[hour] ?? String(hour);
  // Headlines read better rounded: "after two" beats "after 14:15".
  const nextWord = HOUR_WORDS[(hour % 12) + 1] ?? String(hour + 1);
  if (minute === 30) return `half past ${word}`;
  return minute < 30 ? word : nextWord;
}

const COUNT_WORDS = [
  "No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen", "Twenty", "Twenty-one", "Twenty-two",
  "Twenty-three", "Twenty-four",
];

const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

/** The longest open stretch that hasn't already passed. */
function longestOpenStretch(events: EventBlock[], now: string) {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  let best: { start: string; minutes: number } | null = null;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = minutesOf(sorted[i].endTime);
    const span = minutesOf(sorted[i + 1].startTime) - start;
    if (span >= 90 && start >= minutesOf(now) && (!best || span > best.minutes)) {
      best = { start: timeOf(start), minutes: span };
    }
  }

  const tail = minutesOf(sorted[sorted.length - 1].endTime);
  const tailSpan = DAY_END_HOUR * 60 - tail;
  if (tailSpan >= 180 && tail >= minutesOf(now) && (!best || tailSpan > best.minutes)) {
    best = { start: timeOf(tail), minutes: tailSpan };
  }
  return best;
}

export function headlineForDay(events: EventBlock[], now: string): string {
  if (events.length === 0) return "Nothing on the books.\nKeep it that way.";

  const count = NUMBER_WORDS[events.length] ?? `${events.length} things`;
  const open = longestOpenStretch(events, now);
  if (open) return `${count} today,\nand a clear stretch after ${spokenTime(open.start)}.`;

  const last = [...events].sort((a, b) => minutesOf(a.endTime) - minutesOf(b.endTime)).at(-1)!;
  return `${count} today,\nback-to-back until ${spokenTime(last.endTime)}.`;
}

export function headlineForWeek(days: DaySummary[]): string {
  const committed = days
    .flatMap((day) => day.events)
    .reduce((total, event) => total + durationMinutes(event), 0);
  const hours = Math.round(committed / 60);
  const clear = days.find((day) => day.events.length === 0 && !day.isToday);

  const first = `${countWord(hours)} hour${hours === 1 ? "" : "s"} committed.`;
  if (clear) {
    return `${first}\n${WEEKDAY_LONG[parseISODate(clear.date).getDay()]} is still yours.`;
  }
  return `${first}\nEvery day has something.`;
}
