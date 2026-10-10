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
  for (const preferredOnly of [true, false]) {
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

export type ConflictOutcome = {
  moved: { title: string; from: string; to: string; task_id: string | null }[];
  unresolved: { title: string; task_id: string | null; reason: string }[];
};

/**
 * Called after a one-off event lands: task-backed blocks that now overlap it get
 * rescheduled into the next slot that still meets their deadline. Anything that
 * can't move is flagged rather than silently dropped.
 */
export async function resolveConflicts(
  date: string,
  newBlock: ScheduledBlockRow,
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
      // Another fixed commitment or one-off event — not ours to move.
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
