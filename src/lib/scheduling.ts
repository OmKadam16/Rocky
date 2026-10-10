/**
 * Slot-finding and conflict resolution, over Dexie.
 *
 * Ported from the server-side engine this app used to run (git 980f27c,
 * server/scheduling.ts). The logic is unchanged; only the data access moved from
 * Supabase to the local database.
 */
import { db } from "./db";
import type {
  FixedCommitmentRow,
  PreferencesRow,
  ScheduledBlockRow,
  TaskRow,
} from "../../shared/db";
import { addDays, minutesOf, parseISODate, timeOf, toISODate, trimTime } from "../../shared/datetime";
import { isActive } from "./schedule";

const SLOT_STEP_MINUTES = 15;
const DEFAULT_SEARCH_DAYS = 14;

export type Interval = { start: number; end: number };

export async function loadPreferences(): Promise<PreferencesRow> {
  const prefs = await db.preferences.get(1);
  return (
    prefs ?? {
      id: 1,
      earliest_start_time: "07:00",
      latest_end_time: "22:00",
      buffer_minutes_after_fixed_events: 15,
      preferred_study_hours: [],
    }
  );
}

export async function loadCommitments(): Promise<FixedCommitmentRow[]> {
  return db.fixed_commitments.toArray();
}

export async function loadBlocks(from: string, to: string): Promise<ScheduledBlockRow[]> {
  const rows = await db.scheduled_blocks.where("date").between(from, to, true, true).toArray();
  return rows.sort(
    (a, b) => a.date.localeCompare(b.date) || minutesOf(a.start_time) - minutesOf(b.start_time),
  );
}

export async function loadTasks(status?: TaskRow["status"]): Promise<TaskRow[]> {
  const rows = status
    ? await db.tasks.where("status").equals(status).toArray()
    : await db.tasks.toArray();
  // Nulls last, matching the old `order("deadline", { nullsFirst: false })`.
  return rows.sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
}

/** Everything already occupying time on `date`, as minute intervals. */
export function busyIntervals(
  date: string,
  blocks: ScheduledBlockRow[],
  commitments: FixedCommitmentRow[],
  prefs: PreferencesRow,
  ignoreBlockId?: string,
): Interval[] {
  const weekday = parseISODate(date).getDay();
  const fixed = commitments
    .filter((c) => c.days_of_week.includes(weekday))
    .map((c) => ({
      start: minutesOf(c.start_time),
      // Fixed events get a buffer afterwards, per Preferences.
      end: minutesOf(c.end_time) + prefs.buffer_minutes_after_fixed_events,
    }));

  const scheduled = blocks
    .filter((b) => b.date === date && b.id !== ignoreBlockId)
    .map((b) => ({ start: minutesOf(b.start_time), end: minutesOf(b.end_time) }));

  return [...fixed, ...scheduled].sort((a, b) => a.start - b.start);
}

function fits(candidate: Interval, busy: Interval[]): boolean {
  return busy.every((b) => candidate.end <= b.start || candidate.start >= b.end);
}

/** True when the candidate sits inside one of the preferred study windows. */
function inPreferredHours(candidate: Interval, prefs: PreferencesRow): boolean {
  return (prefs.preferred_study_hours ?? []).some(
    (w) => candidate.start >= minutesOf(w.start) && candidate.end <= minutesOf(w.end),
  );
}

export type SlotSearch = {
  durationMinutes: number;
  /** Don't schedule before this date (default: today). */
  earliestDate?: string;
  /** Don't schedule after this date (default: earliest + 14 days). */
  deadline?: string;
  /** Don't schedule before this time on the earliest date (default: now). */
  earliestTime?: string;
  ignoreBlockId?: string;
  /** Urgent requests skip the preferred-hours-first pass and take the earliest fitting slot. */
  ignorePreferred?: boolean;
};

export type Slot = { date: string; start_time: string; end_time: string; preferred: boolean };

/**
 * Pure slot search — no database access, so it can be reasoned about and tested
 * on its own. `findOpenSlot` is the thin wrapper that loads the real data.
 */
export function pickSlot(
  search: SlotSearch,
  world: {
    prefs: PreferencesRow;
    commitments: FixedCommitmentRow[];
    blocks: ScheduledBlockRow[];
    today: string;
    nowMinutes: number;
  },
): Slot | null {
  const { prefs, commitments, blocks, today, nowMinutes } = world;
  const earliestDate = search.earliestDate ?? today;
  const lastDate = search.deadline ?? addDays(earliestDate, DEFAULT_SEARCH_DAYS);
  const dayStart = minutesOf(prefs.earliest_start_time);
  const dayEnd = minutesOf(prefs.latest_end_time);

  // Two passes: preferred study hours first, then anywhere in the allowed window.
  // Urgent requests skip straight to the earliest fitting slot.
  const passes = search.ignorePreferred ? [false] : [true, false];
  for (const preferredOnly of passes) {
    for (let date = earliestDate; date <= lastDate; date = addDays(date, 1)) {
      const busy = busyIntervals(date, blocks, commitments, prefs, search.ignoreBlockId);
      const floor =
        date === today
          ? Math.max(dayStart, search.earliestTime ? minutesOf(search.earliestTime) : nowMinutes)
          : dayStart;

      for (
        let start = Math.ceil(floor / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
        start + search.durationMinutes <= dayEnd;
        start += SLOT_STEP_MINUTES
      ) {
        const candidate = { start, end: start + search.durationMinutes };
        if (!fits(candidate, busy)) continue;
        const preferred = inPreferredHours(candidate, prefs);
        if (preferredOnly && !preferred) continue;
        return {
          date,
          start_time: timeOf(candidate.start),
          end_time: timeOf(candidate.end),
          preferred,
        };
      }
    }
  }
  return null;
}

/** First slot that respects Preferences, fixed commitments and existing blocks. */
export async function findOpenSlot(search: SlotSearch): Promise<Slot | null> {
  const today = toISODate(new Date());
  const earliestDate = search.earliestDate ?? today;
  const lastDate = search.deadline ?? addDays(earliestDate, DEFAULT_SEARCH_DAYS);

  const [prefs, commitments, blocks] = await Promise.all([
    loadPreferences(),
    loadCommitments(),
    loadBlocks(earliestDate, lastDate),
  ]);

  const now = new Date();
  return pickSlot(search, {
    prefs,
    commitments,
    blocks,
    today,
    nowMinutes: now.getHours() * 60 + now.getMinutes(),
  });
}

/** Part-of-day windows for stepwise day planning ("morning", "before 10"). */
export const PART_OF_DAY: Record<string, { start: string; end: string }> = {
  morning: { start: "06:00", end: "12:00" },
  afternoon: { start: "12:00", end: "17:00" },
  evening: { start: "17:00", end: "22:00" },
  night: { start: "21:00", end: "23:00" },
};

export type AnchorName = keyof typeof PART_OF_DAY;

/** Fallback lengths used only when the user won't give one — always stated aloud. */
const DEFAULT_DURATIONS: { match: RegExp; minutes: number }[] = [
  { match: /\b(yoga|gym|workout|run|walk|swim)\b/i, minutes: 60 },
  { match: /\b(breakfast|coffee)\b/i, minutes: 45 },
  { match: /\b(lunch)\b/i, minutes: 60 },
  { match: /\b(dinner|date night)\b/i, minutes: 90 },
  { match: /\b(party|concert|movie|game night)\b/i, minutes: 120 },
  { match: /\b(meeting|call|standup|sync)\b/i, minutes: 30 },
  { match: /\b(study|homework|revision|reading)\b/i, minutes: 60 },
  { match: /\b(class|lecture|lesson)\b/i, minutes: 90 },
];

export function defaultDurationFor(title: string): number {
  const hit = DEFAULT_DURATIONS.find((d) => d.match.test(title ?? ""));
  return hit ? hit.minutes : 60;
}

export type MiddleSearch = {
  durationMinutes: number;
  /** Lower bound in minutes past midnight (already narrowed by anchor/constraints). */
  lowerMinutes: number;
  /** Upper bound in minutes past midnight. */
  upperMinutes: number;
};

/**
 * Pure middle-of-window pick — no database access. Centers the block in
 * [lower, upper], snaps to :00/:30, then searches outward in 15-minute steps
 * for the nearest fit. Busy covers fixed commitments plus their buffer, so a
 * middle pick never lands on a class. Returns null when nothing fits.
 */
export function middleSlot(
  date: string,
  search: MiddleSearch,
  world: {
    prefs: PreferencesRow;
    commitments: FixedCommitmentRow[];
    blocks: ScheduledBlockRow[];
    ignoreBlockId?: string;
  },
): Slot | null {
  const { prefs, commitments, blocks } = world;
  const lo = Math.max(search.lowerMinutes, minutesOf(prefs.earliest_start_time));
  const hi = Math.min(search.upperMinutes, minutesOf(prefs.latest_end_time));
  if (hi - lo < search.durationMinutes) return null;

  const busy = busyIntervals(date, blocks, commitments.filter((c) => {
    const weekday = parseISODate(date).getDay();
    return c.days_of_week.includes(weekday) && isActive(date, c);
  }), prefs, world.ignoreBlockId);

  const snap30 = (m: number) => Math.round(m / 30) * 30;
  const center = lo + Math.floor((hi - lo - search.durationMinutes) / 2);
  const firstTry = Math.max(lo, Math.min(snap30(center), hi - search.durationMinutes));

  // Outward from the middle: center, then alternating earlier/later in steps.
  const starts: number[] = [firstTry];
  for (let step = SLOT_STEP_MINUTES; step <= hi - lo; step += SLOT_STEP_MINUTES) {
    const earlier = firstTry - step;
    const later = firstTry + step;
    if (snap30(earlier) >= lo && !starts.includes(snap30(earlier))) starts.push(snap30(earlier));
    if (later + search.durationMinutes <= hi && !starts.includes(snap30(later))) starts.push(snap30(later));
    if (starts.length > 96) break;
  }

  for (const start of starts) {
    if (start < lo || start + search.durationMinutes > hi) continue;
    const candidate = { start, end: start + search.durationMinutes };
    if (!fits(candidate, busy)) continue;
    return {
      date,
      start_time: timeOf(candidate.start),
      end_time: timeOf(candidate.end),
      preferred: inPreferredHours(candidate, prefs),
    };
  }
  return null;
}

export type MiddleSlotRequest = {
  date: string;
  anchor?: string;
  /** Narrow the anchor window, "HH:MM". */
  earliest?: string;
  /** Narrow the anchor window, "HH:MM". */
  latest?: string;
  /** Minutes; defaults from the activity title when omitted. */
  durationMinutes?: number;
  title?: string;
};

/** Async wrapper: resolves the anchor/constraints against prefs, then picks the middle. */
export async function suggestMiddleSlot(req: MiddleSlotRequest): Promise<{
  slot: Slot | null;
  durationMinutes: number;
  durationAssumed: boolean;
  window: { start_time: string; end_time: string };
  reason?: string;
}> {
  const anchor = PART_OF_DAY[(req.anchor ?? "").toLowerCase()];
  const [prefs, commitments, blocks] = await Promise.all([
    loadPreferences(),
    loadCommitments(),
    loadBlocks(req.date, req.date),
  ]);
  const durationAssumed = !Number.isFinite(Number(req.durationMinutes));
  const duration = durationAssumed
    ? defaultDurationFor(req.title ?? "")
    : Math.max(15, Math.min(480, Number(req.durationMinutes)));
  const lo = Math.max(
    anchor ? minutesOf(anchor.start) : 0,
    req.earliest && /^\d{1,2}:\d{2}$/.test(req.earliest) ? minutesOf(req.earliest) : 0,
  );
  const hi = Math.min(
    anchor ? minutesOf(anchor.end) : 24 * 60,
    req.latest && /^\d{1,2}:\d{2}$/.test(req.latest) ? minutesOf(req.latest) : 24 * 60,
  );
  const window = {
    start_time: timeOf(Math.max(lo, minutesOf(prefs.earliest_start_time))),
    end_time: timeOf(Math.min(hi, minutesOf(prefs.latest_end_time))),
  };
  const slot = middleSlot(req.date, { durationMinutes: duration, lowerMinutes: lo, upperMinutes: hi }, {
    prefs,
    commitments,
    blocks,
  });
  return {
    slot,
    durationMinutes: duration,
    durationAssumed,
    window,
    reason: slot ? undefined : `Nothing free for ${duration} minutes between ${window.start_time} and ${window.end_time}.`,
  };
}

export type ConflictOutcome = {
  moved: { title: string; from: string; to: string; task_id: string | null }[];
  unresolved: { title: string; task_id: string | null; reason: string }[];
};

/**
 * Called after a one-off event lands: overlapping blocks get rescheduled into
 * the next fitting slot, lowest priority first. Task blocks always move when
 * they can (flagged, never dropped, when they cannot). Overlapping one-off
 * events only move for urgent requests — otherwise they are reported as
 * unresolved so the user decides. Fixed commitments never move.
 */
export async function resolveConflicts(
  date: string,
  newBlock: ScheduledBlockRow,
  opts?: { urgent?: boolean },
): Promise<ConflictOutcome> {
  const outcome: ConflictOutcome = { moved: [], unresolved: [] };

  const blocks = await loadBlocks(date, date);
  const clashing = blocks.filter(
    (b) =>
      b.id !== newBlock.id &&
      minutesOf(b.start_time) < minutesOf(newBlock.end_time) &&
      minutesOf(newBlock.start_time) < minutesOf(b.end_time),
  );
  if (clashing.length === 0) return outcome;

  const tasks = await loadTasks();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Lowest priority moves first.
  const rank = { low: 0, normal: 1, high: 2 } as const;
  clashing.sort((a, b) => {
    const pa = a.source_id ? rank[taskById.get(a.source_id)?.priority ?? "normal"] : 3;
    const pb = b.source_id ? rank[taskById.get(b.source_id)?.priority ?? "normal"] : 3;
    return pa - pb;
  });

  for (const block of clashing) {
    const task = block.source_id ? taskById.get(block.source_id) : undefined;

    if (block.source_type !== "task" || !task) {
      // Urgent requests displace overlapping one-off events too; anything
      // else is reported so the user decides.
      if (block.source_type === "event" && opts?.urgent) {
        const duration = minutesOf(block.end_time) - minutesOf(block.start_time);
        const slot = await findOpenSlot({
          durationMinutes: duration,
          earliestDate: date,
          ignoreBlockId: block.id,
          ignorePreferred: true,
        });
        if (!slot) {
          outcome.unresolved.push({
            title: block.title,
            task_id: null,
            reason: `"${block.title}" also runs then and no other slot fits even for an urgent request.`,
          });
          continue;
        }
        await db.scheduled_blocks.update(block.id, {
          date: slot.date,
          start_time: slot.start_time,
          end_time: slot.end_time,
          previous_start_time: trimTime(block.start_time),
        });
        outcome.moved.push({
          title: block.title,
          from: `${block.date} ${trimTime(block.start_time)}`,
          to: `${slot.date} ${slot.start_time}`,
          task_id: null,
        });
        continue;
      }
      outcome.unresolved.push({
        title: block.title,
        task_id: null,
        reason: `"${block.title}" also runs then and isn't a task block, so it can't be moved automatically.`,
      });
      continue;
    }

    const duration = minutesOf(block.end_time) - minutesOf(block.start_time);
    const slot = await findOpenSlot({
      durationMinutes: duration,
      earliestDate: date,
      deadline: task.deadline ?? undefined,
      ignoreBlockId: block.id,
      ignorePreferred: opts?.urgent,
    });

    if (!slot) {
      const reason = `No open slot of ${duration} min before ${task.deadline ?? "its deadline"}.`;
      await flagConflict(task.id, reason);
      outcome.unresolved.push({ title: block.title, task_id: task.id, reason });
      continue;
    }

    await db.scheduled_blocks.update(block.id, {
      date: slot.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
      previous_start_time: trimTime(block.start_time),
    });

    outcome.moved.push({
      title: block.title,
      from: `${block.date} ${trimTime(block.start_time)}`,
      to: `${slot.date} ${slot.start_time}`,
      task_id: task.id,
    });
  }

  return outcome;
}

export async function flagConflict(taskId: string, reason: string) {
  await db.tasks.update(taskId, { status: "blocked", conflict_reason: reason });
}
