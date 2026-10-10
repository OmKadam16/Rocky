/**
 * The tools the planner model can call, and their Dexie implementations.
 *
 * Ported from the server-side version (git 980f27c, server/tools.ts). Behaviour
 * is unchanged; the 25 Supabase calls became local database operations.
 */
import type OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { db } from "./db";
import { isActive } from "./schedule";
import { ASSIGNMENTS_ENABLED } from "./features";
import {
  findOpenSlot,
  flagConflict,
  loadCommitments,
  loadBlocks,
  busyIntervals,
  loadPreferences,
  loadTasks,
  resolveConflicts,
  suggestMiddleSlot,
} from "./scheduling";
import type { FixedCommitmentRow, PreferencesRow, ScheduledBlockRow, TaskRow } from "../../shared/db";
import {
  buildBookingSearchUrl,
  buildHoldTitle,
  formatProposal,
  liveModelCall,
  missingBookingSlots,
  nextBookingQuestion,
  rememberArea,
  rememberedArea,
  runBookingLoop,
  type BookingIntent,
} from "./browserAgent";
import { agentClick, agentClose, agentNavigate, agentOpen, agentSnapshot, agentType, isAgentAvailable } from "./browserDriver";
import {
  WEEKDAY_LONG,
  addDays,
  minutesOf,
  mondayOf,
  parseISODate,
  toISODate,
  trimTime,
  weekDates,
} from "../../shared/datetime";

/** Tools that change the calendar — used to decide whether the views must refresh. */
export const MUTATING_TOOLS = new Set([
  "add_task",
  "add_one_off_event",
  "place_sequence",
  "reorder_blocks",
  "move_task_to_slot",
  "flag_unresolvable_conflict",
  "add_note_to_block",
  "delete_block",
  "reschedule_block",
  "add_assignment",
  "add_assignment_part",
  "set_task_status",
  "propose_booking",
  "book_appointment",
]);

const ALL_TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_week_schedule",
      description:
        "Everything scheduled for the week containing start_date: one-off events, task blocks and recurring fixed commitments, day by day.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Any date in the week, YYYY-MM-DD. Defaults to today." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pending_tasks",
      description: "Tasks that still need a slot on the calendar, plus any flagged as blocked.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_task",
      description:
        "Create a task. Records the work; does not place it on the calendar — use find_open_slot then move_task_to_slot for that.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          deadline: { type: "string", description: "YYYY-MM-DD" },
          estimated_duration: { type: "integer", description: "Minutes" },
          priority: { type: "string", enum: ["high", "normal", "low"] },
          linked_class_or_project: { type: "string" },
        },
        required: ["name", "estimated_duration"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_one_off_event",
      description:
        "Put a fixed one-off event on the calendar (dinner, a friend, an appointment). Conflicting task blocks are rescheduled automatically and reported back to you.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          start_time: { type: "string", description: "HH:MM, 24-hour" },
          end_time: { type: "string", description: "HH:MM, 24-hour" },
        },
        required: ["title", "date", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_sequence",
      description:
        "Place two or more back-to-back items on one day — 'a study session and then dinner', 'gym, shower and breakfast before class'. Works out the window, checks everything fits, and leaves a gap between each. Only for items meant to run back-to-back in one run; items spread across the day (morning yoga, evening dinner) get separate add_one_off_event calls instead.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          items: {
            type: "array",
            description: "In the order the user wants them.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                duration_minutes: { type: "integer" },
              },
              required: ["title", "duration_minutes"],
            },
          },
          after: {
            type: "string",
            description:
              "Start the run after this. Either HH:MM or the name of an event or fixed commitment on that day, e.g. 'Chem Lab'.",
          },
          before: {
            type: "string",
            description: "Finish the run before this. Either HH:MM or the name of something on that day.",
          },
          gap_minutes: { type: "integer", description: "Breathing room between items. Defaults to 10." },
        },
        required: ["date", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_blocks",
      description:
        "Rearrange things already on the calendar into a different order — 'switch dinner and the study session', 'put the study session first', 'swap those two'. Keeps each item's length, lays them out in the order given starting from wherever the earliest one currently begins, and leaves a gap between each. Use this for any swap: moving them one at a time cannot work, because the first move lands on top of the second item.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          order: {
            type: "array",
            description: "Titles of the blocks, in the order the user now wants them. Two or more.",
            items: { type: "string" },
          },
          start_time: {
            type: "string",
            description: "HH:MM to begin the run. Defaults to wherever the earliest of them currently starts.",
          },
          gap_minutes: {
            type: "integer",
            description: "Gap between them. Defaults to the spacing they already have.",
          },
        },
        required: ["date", "order"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_middle_slot",
      description:
        "Pick a sensible time inside part of a day when the user won't give an exact time ('morning', 'before 10'). Centers the block in the window, snaps to :00/:30, nudges to the nearest free stretch — never over a fixed commitment. Pass the activity title so a fallback length can be assumed (returned as duration_assumed — always state it aloud). Then book the returned slot with add_one_off_event.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          title: { type: "string", description: "Activity title, used for the fallback length" },
          anchor: { type: "string", enum: ["morning", "afternoon", "evening", "night"] },
          earliest: { type: "string", description: "Narrow the window from below, HH:MM ('before 10' → latest 10:00)" },
          latest: { type: "string", description: "Narrow the window from above, HH:MM" },
          duration_minutes: { type: "integer", description: "Exact length when known; omit to assume from the title" },
        },
        required: ["date", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_open_slot",
      description:
        "First free slot of the given length that respects the user's preferences, fixed commitments and existing blocks.",
      parameters: {
        type: "object",
        properties: {
          duration_minutes: { type: "integer" },
          deadline: { type: "string", description: "Don't look past this date, YYYY-MM-DD" },
          earliest_date: { type: "string", description: "Don't look before this date, YYYY-MM-DD" },
        },
        required: ["duration_minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_task_to_slot",
      description:
        "Move a task's block to a new date and time (or create the block if the task has none). Records where it moved from.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          new_date: { type: "string", description: "YYYY-MM-DD" },
          new_start_time: { type: "string", description: "HH:MM" },
          new_end_time: { type: "string", description: "HH:MM" },
        },
        required: ["task_id", "new_date", "new_start_time", "new_end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_unresolvable_conflict",
      description:
        "Mark a task as blocked when there is genuinely no slot for it. Use only when you intend to ask the user what should give.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" }, reason: { type: "string" } },
        required: ["task_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note_to_block",
      description:
        "Attach a short note to a fixed commitment or a scheduled block, e.g. 'add a note to biology class that I have to print the assignment'.",
      parameters: {
        type: "object",
        properties: {
          block_query: { type: "string", description: "Substring of the commitment or block title" },
          raw_note: { type: "string", description: "The user's words; it gets summarised" },
        },
        required: ["block_query", "raw_note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_block",
      description:
        "Delete a scheduled event or task block. If block_query plus date/start_time/end_time match exactly one block, it deletes immediately (fast path, no confirmed needed). Otherwise it returns needs_confirmation — then ask \"Delete <title> <day>? Say yes or tap Confirm\" with no further tool call until the user says yes, then call again with confirmed: true. Never deletes fixed commitments.",
      parameters: {
        type: "object",
        properties: {
          block_query: { type: "string" },
          date: { type: "string", description: "Optional YYYY-MM-DD to disambiguate" },
          start_time: { type: "string", description: "Optional HH:MM hint for the block to delete, e.g. 16:30" },
          end_time: { type: "string", description: "Optional HH:MM hint for the block to delete, e.g. 18:30" },
          confirmed: { type: "boolean", description: "True only after the user said yes on a later turn" },
        },
        required: ["block_query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_block",
      description:
        "Move an existing event or task block to a new date and time. Pass date/start_time/end_time when the user named the block's current time (e.g. math 4:30-6:30) to disambiguate which one to move.",
      parameters: {
        type: "object",
        properties: {
          block_query: { type: "string" },
          date: { type: "string", description: "Optional YYYY-MM-DD of the block as it stands now" },
          start_time: { type: "string", description: "Optional HH:MM of the block as it stands now" },
          end_time: { type: "string", description: "Optional HH:MM of the block as it stands now" },
          new_date: { type: "string", description: "YYYY-MM-DD" },
          new_start_time: { type: "string", description: "HH:MM" },
          new_end_time: { type: "string", description: "HH:MM" },
        },
        required: ["block_query", "new_date", "new_start_time", "new_end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_assignment",
      description:
        "Create an assignment with a due date and automatically chunk it across open slots. Use when the user gives a due date but no exact time slot.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          deadline: { type: "string", description: "YYYY-MM-DD" },
          estimated_duration: { type: "integer", description: "Total minutes, 15–480" },
          priority: { type: "string", enum: ["high", "normal", "low"] },
          linked_class_or_project: { type: "string" },
          color: { type: "string" },
        },
        required: ["name", "deadline", "estimated_duration"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_assignment_part",
      description:
        "Place one working session for an existing assignment at an exact time the user gave. Use instead of add_assignment when they name a specific slot.",
      parameters: {
        type: "object",
        properties: {
          assignment_query: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          start_time: { type: "string", description: "HH:MM" },
          end_time: { type: "string", description: "HH:MM" },
          part_name: { type: "string" },
        },
        required: ["assignment_query", "date", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_task_status",
      description: "Mark a task as incomplete (pending), in_progress, scheduled, done, or blocked. Use when user says completed/in progress/done.",
      parameters: {
        type: "object",
        properties: {
          task_query: { type: "string", description: "Substring of task name" },
          status: { type: "string", enum: ["pending", "in_progress", "scheduled", "done", "blocked"] },
        },
        required: ["task_query", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_restaurant",
      description:
        "Look up a restaurant or venue booking page for an area. Read-only: confirms venue + area and hands back a booking search link. If area is missing and none is remembered, it tells you to ask for the city — never guess it.",
      parameters: {
        type: "object",
        properties: {
          venue: { type: "string", description: "Restaurant or venue name" },
          area: { type: "string", description: "City or neighbourhood" },
        },
        required: ["venue"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_booking",
      description:
        "Propose a restaurant or appointment booking: checks the calendar (fixed commitments still win), holds the slot, and returns one summary line to read to the user. It never books — missing details come back as a single question to ask.",
      parameters: {
        type: "object",
        properties: {
          venue: { type: "string" },
          area: { type: "string", description: "City or neighbourhood" },
          date: { type: "string", description: "YYYY-MM-DD" },
          start_time: { type: "string", description: "HH:MM" },
          end_time: { type: "string", description: "HH:MM, defaults to 90 minutes after start" },
          party_size: { type: "integer" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book after an explicit yes. Without confirmed:true it only returns a confirmation preview — call it again with confirmed:true and the hold_block_id on a later turn. With confirmation it drives the booking page in the desktop agent window to completion (booked, blocked, or failed), or hands back a deep link when there is no agent window.",
      parameters: {
        type: "object",
        properties: {
          venue: { type: "string" },
          area: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          start_time: { type: "string", description: "HH:MM" },
          end_time: { type: "string", description: "HH:MM" },
          party_size: { type: "integer" },
          hold_block_id: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: [],
      },
    },
  },
];

/**
 * Assignment creation is withheld from the model while assignments live behind
 * student mode. The runTool cases below stay intact — they simply have no
 * caller — so restoring is one flag.
 *
 * add_task is in here too: its parameters are the assignment shape (deadline,
 * estimated_duration, priority, linked_class_or_project) and it writes the same
 * `tasks` rows, so leaving it visible would just be a back door.
 *
 * get_pending_tasks, move_task_to_slot and flag_unresolvable_conflict stay —
 * they only read, move or flag rows that already exist, which is what keeps the
 * surviving task blocks manageable.
 */
const HIDDEN_TOOLS = ASSIGNMENTS_ENABLED
  ? new Set<string>()
  : new Set(["add_assignment", "add_assignment_part", "add_task"]);

export const toolSchemas: ChatCompletionTool[] = ALL_TOOL_SCHEMAS.filter(
  (tool) => tool.type !== "function" || !HIDDEN_TOOLS.has(tool.function.name),
);

type Args = Record<string, any>;

/** The model client, so note summarisation can reuse the user's key. Urgent turns displace rather than defer. */
export type ToolContext = { openai: OpenAI; model: string; urgent?: boolean };

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Token-based fuzzy match: every word in the query must appear in the title.
 * "math problems" matches "Math Problems (1/2)" and "math-problems review".
 * Falls back to substring for single-token queries.
 */
function matchesQuery(haystack: string | null | undefined, needle: string): boolean {
  const hay = (haystack ?? "").toLowerCase();
  const q = needle.trim().toLowerCase();
  if (!q) return false;
  if (hay.includes(q)) return true;
  const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length <= 1) return false;
  return tokens.every((t) => hay.includes(t));
}

/** "16:30" -> minutes, null for anything else. */
function timeHintToMinutes(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** True when a block overlaps the optional time hints (used to disambiguate). */
function overlapsTimeHint(
  block: ScheduledBlockRow,
  startHint: number | null,
  endHint: number | null,
): boolean {
  if (startHint === null && endHint === null) return true;
  const s = minutesOf(block.start_time);
  const e = minutesOf(block.end_time);
  const qs = startHint ?? endHint!;
  const qe = endHint ?? startHint!;
  return s < qe && qs < e;
}

const formatBlockRef = (b: ScheduledBlockRow) =>
  `"${b.title}" on ${b.date} ${trimTime(b.start_time)}-${trimTime(b.end_time)}`;

/** The planner must never book into the past — spoken weekday names are ambiguous. */
function pastDateError(date: string, field: string) {
  const today = toISODate(new Date());
  if (date >= today) return null;
  return {
    error: `${field} ${date} is in the past (today is ${today}). Weekday names always mean the next such day on or after today — see upcoming_dates in your context.`,
  };
}

/** Fixed commitments always win; nothing may be booked over one. */
async function fixedOverlapError(date: string, startTime: string, endTime: string) {
  const [prefs, commitments] = await Promise.all([loadPreferences(), loadCommitments()]);
  const candidate = { start: minutesOf(startTime), end: minutesOf(endTime) };
  const weekday = parseISODate(date).getDay();
  for (const c of commitments) {
    if (!c.days_of_week.includes(weekday) || !isActive(date, c)) continue;
    const interval = {
      start: minutesOf(c.start_time),
      end: minutesOf(c.end_time) + prefs.buffer_minutes_after_fixed_events,
    };
    if (candidate.start < interval.end && interval.start < candidate.end) {
      return {
        error: `Overlaps fixed commitment "${c.name}" (${trimTime(c.start_time)}–${trimTime(c.end_time)} on ${WEEKDAY_LONG[weekday]}). Fixed commitments cannot be moved by the assistant — tell the user they'd need to change it under Fixed commitments.`,
      };
    }
  }
  return null;
}

/**
 * Two events may not sit on top of each other.
 *
 * resolveConflicts shuffles task blocks out of the way but leaves events alone,
 * so nothing stopped a study session and a dinner being written to the same
 * half hour — which is exactly what happened. Task blocks stay out of this:
 * they are meant to be displaced.
 */
async function eventOverlapError(date: string, startTime: string, endTime: string, ignoreBlockId?: string) {
  const blocks = await loadBlocks(date, date);
  const candidate = { start: minutesOf(startTime), end: minutesOf(endTime) };
  for (const b of blocks) {
    if (b.id === ignoreBlockId || b.source_type !== "event") continue;
    const interval = { start: minutesOf(b.start_time), end: minutesOf(b.end_time) };
    if (candidate.start < interval.end && interval.start < candidate.end) {
      const [prefs, commitments] = await Promise.all([loadPreferences(), loadCommitments()]);
      const free = freeWindows(date, blocks, commitments.filter((c) => isActive(date, c)), prefs);
      return {
        error:
          `Overlaps "${b.title}" (${trimTime(b.start_time)}–${trimTime(b.end_time)}). Nothing was added. ` +
          `Free on ${date}: ${free.map((w) => `${w.start_time}-${w.end_time}`).join(", ") || "nothing"}. ` +
          `Either pick a time inside one of those, or ask the user which of the two should move.`,
      };
    }
  }
  return null;
}

/**
 * Breathing room between back-to-back items the assistant places itself.
 *
 * The user asked for a study session and dinner in one breath and got two
 * blocks starting at the same minute. Ten minutes is short enough to be
 * invisible when it does not matter and long enough to be a real break.
 */
const DEFAULT_GAP_MINUTES = 10;

/**
 * "Chem Lab", "18:30" or nothing -> a minute of the day to work from.
 * Returns null when a name was given and nothing on that day answers to it.
 */
function resolveBoundary(
  raw: unknown,
  date: string,
  blocks: ScheduledBlockRow[],
  commitments: FixedCommitmentRow[],
  prefs: PreferencesRow,
  edge: "start" | "end",
): number | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^\d{1,2}:\d{2}$/.test(value)) return minutesOf(value);

  const weekday = parseISODate(date).getDay();
  const commitment = commitments.find((c) => c.days_of_week.includes(weekday) && matchesQuery(c.name, value));
  if (commitment) {
    return edge === "end"
      // A fixed commitment's buffer belongs to whatever follows it.
      ? minutesOf(commitment.end_time) + prefs.buffer_minutes_after_fixed_events
      : minutesOf(commitment.start_time);
  }
  const block = blocks.find((b) => b.date === date && matchesQuery(b.title, value));
  if (block) return minutesOf(edge === "end" ? block.end_time : block.start_time);
  return null;
}

/** Notes are stored as a few words, not a transcript. */
async function summarizeNote(raw: string, ctx?: ToolContext): Promise<string> {
  const text = raw.trim().slice(0, 500);
  if (text.length <= 20) return text.toLowerCase();
  try {
    if (!ctx) return text.slice(0, 60).toLowerCase();
    const completion = await ctx.openai.chat.completions.create({
      model: ctx.model,
      messages: [
        {
          role: "system",
          content:
            "Summarize the user note to 2-4 words, lowercase, no punctuation, just the action. Example: 'So I have this paper assignment that I have to do, add a note to print the assignment' → 'print assignment'. Return only the summary.",
        },
        { role: "user", content: text },
      ],
    });
    const summary =
      completion.choices[0]?.message?.content?.trim().toLowerCase().replace(/^[\s"'`]+|[\s"'`]+$/g, "") ?? text;
    return summary.slice(0, 60) || text.slice(0, 60).toLowerCase();
  } catch {
    return text.split(/\s+/).slice(-3).join(" ").toLowerCase().slice(0, 60) || text.slice(0, 60).toLowerCase();
  }
}

async function weekSchedule(startDate?: string) {
  const anchor = startDate ?? toISODate(new Date());
  const dates = weekDates(anchor);
  const [blocks, commitments, prefs] = await Promise.all([
    loadBlocks(dates[0], dates[6]),
    loadCommitments(),
    loadPreferences(),
  ]);

  return {
    week_of: mondayOf(anchor),
    days: dates.map((date) => {
      const weekday = parseISODate(date).getDay();
      const dayCommitments = commitments.filter(
        // isActive too: the calendar hides commitments outside their active
        // window, and the model must be shown the same week the user sees.
        (c) => c.days_of_week.includes(weekday) && isActive(date, c),
      );
      const dayBlocks = blocks.filter((b) => b.date === date);
      return {
        date,
        weekday: WEEKDAY_LONG[weekday],
        // Every day carries its own gaps, not just today. The model was left to
        // do the interval arithmetic for any other day and got it wrong — it
        // called 20:00 blocked by a lab that ended at 17:50.
        free_windows: freeWindows(date, dayBlocks, dayCommitments, prefs),
        fixed_commitments: dayCommitments
          .map((c) => ({
            id: c.id,
            name: c.name,
            immutable: true,
            start_time: trimTime(c.start_time),
            end_time: trimTime(c.end_time),
            notes: c.notes ?? null,
          })),
        blocks: dayBlocks
          .map((b) => ({
            id: b.id,
            title: b.title,
            source_type: b.source_type,
            task_id: b.source_id,
            start_time: trimTime(b.start_time),
            end_time: trimTime(b.end_time),
            moved_from: b.previous_start_time ? trimTime(b.previous_start_time) : null,
            notes: b.notes ?? null,
          })),
      };
    }),
  };
}

async function insertBlock(row: Omit<ScheduledBlockRow, "id" | "created_at" | "previous_start_time"> & {
  previous_start_time?: string | null;
}): Promise<ScheduledBlockRow> {
  const block: ScheduledBlockRow = {
    id: newId(),
    created_at: new Date().toISOString(),
    previous_start_time: row.previous_start_time ?? null,
    ...row,
  };
  await db.scheduled_blocks.put(block);
  return block;
}

/** Runs one tool call and returns a JSON-serialisable result for the model. */
export async function runTool(name: string, args: Args, ctx?: ToolContext): Promise<unknown> {
  switch (name) {
    case "get_week_schedule":
      return weekSchedule(args.start_date);

    case "get_pending_tasks": {
      const tasks = await loadTasks();
      return {
        tasks: tasks
          .filter((t) => t.status === "pending" || t.status === "blocked")
          .map((t) => ({
            id: t.id,
            name: t.name,
            deadline: t.deadline,
            estimated_duration: t.estimated_duration,
            priority: t.priority,
            linked_class_or_project: t.linked_class_or_project,
            status: t.status,
            conflict_reason: t.conflict_reason,
          })),
      };
    }

    case "add_task": {
      const task: TaskRow = {
        id: newId(),
        name: args.name,
        deadline: args.deadline ?? null,
        estimated_duration: args.estimated_duration,
        priority: args.priority ?? "normal",
        linked_class_or_project: args.linked_class_or_project ?? null,
        status: "pending",
        conflict_reason: null,
      };
      await db.tasks.put(task);
      return { task };
    }

    case "add_one_off_event": {
      const invalid = pastDateError(args.date, "date");
      if (invalid) return invalid;
      const urgent = ctx?.urgent === true;
      const fixedClash = await fixedOverlapError(args.date, args.start_time, args.end_time);
      if (fixedClash) return fixedClash;
      // Urgent requests displace overlapping one-off events instead of
      // bouncing off them; fixed commitments still always win.
      if (!urgent) {
        const eventClash = await eventOverlapError(args.date, args.start_time, args.end_time);
        if (eventClash) return eventClash;
      }

      const event = await insertBlock({
        source_type: "event",
        source_id: null,
        title: args.title,
        date: args.date,
        start_time: args.start_time,
        end_time: args.end_time,
      });

      // Conflict resolution runs before the model gets control back.
      const outcome = await resolveConflicts(args.date, event, { urgent });
      return {
        event,
        urgent,
        conflicts_resolved: outcome.moved,
        conflicts_unresolved: outcome.unresolved,
        day_after_change: (await weekSchedule(args.date)).days.find((d) => d.date === args.date),
      };
    }

    case "place_sequence": {
      const date = String(args.date ?? "").trim();
      const pd = pastDateError(date, "date");
      if (pd) return pd;

      const items = (Array.isArray(args.items) ? args.items : [])
        .map((i: any) => ({ title: String(i?.title ?? "").trim(), minutes: Number(i?.duration_minutes) }))
        .filter((i) => i.title && Number.isFinite(i.minutes) && i.minutes > 0);
      if (items.length === 0) return { error: "items must hold at least one title and duration." };

      const gap = Number.isFinite(Number(args.gap_minutes)) ? Math.max(0, Number(args.gap_minutes)) : DEFAULT_GAP_MINUTES;
      const [prefs, commitments, blocks] = await Promise.all([
        loadPreferences(),
        loadCommitments(),
        loadBlocks(date, date),
      ]);
      const active = commitments.filter((c) => isActive(date, c));

      const after = resolveBoundary(args.after, date, blocks, active, prefs, "end");
      const before = resolveBoundary(args.before, date, blocks, active, prefs, "start");
      if (args.after && after === null) return { error: `Nothing called "${args.after}" on ${date} — name something that is actually on that day, or give a time as HH:MM.` };
      if (args.before && before === null) return { error: `Nothing called "${args.before}" on ${date} — name something that is actually on that day, or give a time as HH:MM.` };

      const lower = Math.max(after ?? 0, minutesOf(prefs.earliest_start_time));
      const upper = Math.min(before ?? 24 * 60, minutesOf(prefs.latest_end_time));
      const needed = items.reduce((sum, i) => sum + i.minutes, 0) + gap * (items.length - 1);

      // Only the genuinely empty stretches inside the window are candidates.
      const candidates = freeWindows(date, blocks, active, prefs)
        .map((w) => ({ start: Math.max(minutesOf(w.start_time), lower), end: Math.min(minutesOf(w.end_time), upper) }))
        .filter((w) => w.end > w.start);
      const room = candidates.find((w) => w.end - w.start >= needed);

      if (!room) {
        const biggest = candidates.reduce((max, w) => Math.max(max, w.end - w.start), 0);
        return {
          placed: false,
          error:
            `Does not fit. ${items.length} items plus ${gap}-minute gaps need ${needed} minutes, and the longest free stretch ` +
            `between ${fromMinutes(lower)} and ${fromMinutes(upper)} is ${biggest} minutes. Nothing was added. ` +
            `Tell the user the numbers and ask what should give — a shorter session, a different window, or another day.`,
          needed_minutes: needed,
          longest_free_minutes: biggest,
          window: { start_time: fromMinutes(lower), end_time: fromMinutes(upper) },
        };
      }

      const placed = [];
      let cursor = room.start;
      for (const item of items) {
        placed.push(
          await insertBlock({
            source_type: "event",
            source_id: null,
            title: item.title,
            date,
            start_time: fromMinutes(cursor),
            end_time: fromMinutes(cursor + item.minutes),
          }),
        );
        cursor += item.minutes + gap;
      }

      return {
        placed: true,
        gap_minutes: gap,
        blocks: placed.map((b) => ({ title: b.title, start_time: b.start_time, end_time: b.end_time })),
        day_after_change: (await weekSchedule(date)).days.find((d) => d.date === date),
      };
    }

    case "reorder_blocks": {
      const date = String(args.date ?? "").trim();
      const pd = pastDateError(date, "date");
      if (pd) return pd;

      const order = (Array.isArray(args.order) ? args.order : []).map((q: any) => String(q ?? "").trim()).filter(Boolean);
      if (order.length < 2) return { error: "order needs at least two titles — reordering one thing is a reschedule." };

      const dayBlocks = (await loadBlocks(date, date)).filter((b) => b.date === date);
      const targets: ScheduledBlockRow[] = [];
      for (const query of order) {
        const matches = dayBlocks.filter((b) => matchesQuery(b.title, query) && !targets.some((t) => t.id === b.id));
        if (matches.length === 0) {
          const clash = (await loadCommitments()).find((c) => matchesQuery(c.name, query));
          return {
            error: clash
              ? `"${clash.name}" is a fixed commitment — it cannot be reordered. Tell the user it would have to change under Fixed commitments.`
              : `Nothing called "${query}" on ${date}. On that day: ${dayBlocks.map((b) => `"${b.title}"`).join(", ") || "nothing"}.`,
          };
        }
        if (matches.length > 1) {
          const exact = matches.filter((b) => b.title.toLowerCase() === query.toLowerCase());
          if (exact.length !== 1) return { error: `Several blocks match "${query}": ${matches.map((b) => `"${b.title}"`).join(", ")}. Ask which one.` };
          targets.push(exact[0]);
        } else targets.push(matches[0]);
      }

      const starts = targets.map((b) => minutesOf(b.start_time)).sort((a, b) => a - b);
      const ends = targets.map((b) => minutesOf(b.end_time)).sort((a, b) => a - b);
      // Whatever spacing they already have is what the user has just been
      // fiddling with, so keep it unless they say otherwise.
      const existingGaps: number[] = [];
      for (let i = 1; i < starts.length; i += 1) {
        const gapHere = starts[i] - ends[i - 1];
        if (gapHere >= 0) existingGaps.push(gapHere);
      }
      const gap = Number.isFinite(Number(args.gap_minutes))
        ? Math.max(0, Number(args.gap_minutes))
        : existingGaps.length
          ? Math.min(...existingGaps)
          : DEFAULT_GAP_MINUTES;

      const explicitStart = String(args.start_time ?? "").trim();
      let cursor = /^\d{1,2}:\d{2}$/.test(explicitStart) ? minutesOf(explicitStart) : starts[0];

      const layout = targets.map((block) => {
        const minutes = minutesOf(block.end_time) - minutesOf(block.start_time);
        const slot = { block, start: cursor, end: cursor + minutes };
        cursor += minutes + gap;
        return slot;
      });

      // Nothing is written until the whole arrangement is known to be legal.
      const [prefs, commitments] = await Promise.all([loadPreferences(), loadCommitments()]);
      const weekday = parseISODate(date).getDay();
      const moving = new Set(targets.map((b) => b.id));
      const obstacles = [
        ...commitments
          .filter((c) => c.days_of_week.includes(weekday) && isActive(date, c))
          .map((c) => ({
            label: c.name,
            start: minutesOf(c.start_time),
            end: minutesOf(c.end_time) + prefs.buffer_minutes_after_fixed_events,
          })),
        ...dayBlocks
          .filter((b) => !moving.has(b.id))
          .map((b) => ({ label: b.title, start: minutesOf(b.start_time), end: minutesOf(b.end_time) })),
      ];

      for (const slot of layout) {
        const hit = obstacles.find((o) => slot.start < o.end && o.start < slot.end);
        if (hit) {
          return {
            reordered: false,
            error:
              `That order runs "${slot.block.title}" (${fromMinutes(slot.start)}-${fromMinutes(slot.end)}) into "${hit.label}" ` +
              `(${fromMinutes(hit.start)}-${fromMinutes(hit.end)}). Nothing was changed. The run needs ` +
              `${layout[layout.length - 1].end - layout[0].start} minutes from ${fromMinutes(layout[0].start)}. ` +
              `Tell the user what is in the way and ask whether to start earlier, shorten something, or leave it.`,
          };
        }
        if (slot.end > minutesOf(prefs.latest_end_time)) {
          return {
            reordered: false,
            error: `That order runs past the user's latest end time (${trimTime(prefs.latest_end_time)}). Nothing was changed. Ask what should give.`,
          };
        }
      }

      for (const slot of layout) {
        await db.scheduled_blocks.update(slot.block.id, {
          start_time: fromMinutes(slot.start),
          end_time: fromMinutes(slot.end),
          previous_start_time: trimTime(slot.block.start_time),
        });
      }

      return {
        reordered: true,
        gap_minutes: gap,
        blocks: layout.map((slot) => ({
          title: slot.block.title,
          start_time: fromMinutes(slot.start),
          end_time: fromMinutes(slot.end),
          moved_from: trimTime(slot.block.start_time),
        })),
        day_after_change: (await weekSchedule(date)).days.find((d) => d.date === date),
      };
    }

    case "suggest_middle_slot": {
      const date = String(args.date ?? "").trim();
      if (!date) return { error: "date is required — use upcoming_dates for weekday names" };
      const pd = pastDateError(date, "date");
      if (pd) return pd;
      const out = await suggestMiddleSlot({
        date,
        anchor: String(args.anchor ?? "").trim() || undefined,
        earliest: String(args.earliest ?? "").trim() || undefined,
        latest: String(args.latest ?? "").trim() || undefined,
        durationMinutes: Number.isFinite(Number(args.duration_minutes)) ? Number(args.duration_minutes) : undefined,
        title: String(args.title ?? "").trim(),
      });
      return out.slot
        ? { slot: out.slot, duration_minutes: out.durationMinutes, duration_assumed: out.durationAssumed, window: out.window }
        : { slot: null, duration_minutes: out.durationMinutes, duration_assumed: out.durationAssumed, window: out.window, reason: out.reason };
    }

    case "find_open_slot": {
      const slot = await findOpenSlot({
        durationMinutes: args.duration_minutes,
        deadline: args.deadline,
        earliestDate: args.earliest_date,
        ignorePreferred: ctx?.urgent === true,
      });
      return slot ? { slot } : { slot: null, reason: "No slot fits inside the user's preferences." };
    }

    case "move_task_to_slot": {
      const invalid = pastDateError(args.new_date, "new_date");
      if (invalid) return invalid;
      const overlapMove = await fixedOverlapError(args.new_date, args.new_start_time, args.new_end_time);
      if (overlapMove) return overlapMove;

      const task = await db.tasks.get(args.task_id);
      if (!task) return { error: `No task with id ${args.task_id}.` };

      const current = await db.scheduled_blocks
        .where("source_id")
        .equals(args.task_id)
        .filter((b) => b.source_type === "task")
        .first();

      const payload = {
        date: args.new_date,
        start_time: args.new_start_time,
        end_time: args.new_end_time,
      };

      if (current) {
        await db.scheduled_blocks.update(current.id, {
          ...payload,
          previous_start_time: trimTime(current.start_time),
        });
        await db.tasks.update(args.task_id, { status: "scheduled", conflict_reason: null });
        return {
          block: await db.scheduled_blocks.get(current.id),
          moved_from: trimTime(current.start_time),
        };
      }

      const block = await insertBlock({
        source_type: "task",
        source_id: args.task_id,
        title: task.name,
        ...payload,
      });
      await db.tasks.update(args.task_id, { status: "scheduled", conflict_reason: null });
      return { block, moved_from: null };
    }

    case "add_assignment": {
      const dlErr = pastDateError(args.deadline, "deadline");
      if (dlErr) return dlErr;
      const dur = Number(args.estimated_duration);
      if (!Number.isFinite(dur) || dur < 15 || dur > 480) {
        return { error: "estimated_duration must be between 15 and 480 minutes" };
      }

      const task: TaskRow = {
        id: newId(),
        name: args.name,
        deadline: args.deadline,
        estimated_duration: dur,
        priority: args.priority ?? "normal",
        linked_class_or_project: args.linked_class_or_project ?? null,
        color: args.color ?? null,
        status: "pending",
        conflict_reason: null,
      };
      await db.tasks.put(task);

      // Long assignments become hour-long pieces across separate days.
      const chunks: number[] = [];
      let rem = dur;
      while (rem > 60) {
        chunks.push(60);
        rem -= 60;
      }
      if (rem > 0) chunks.push(rem);

      const scheduled: ScheduledBlockRow[] = [];
      let earliest = toISODate(new Date());
      for (let i = 0; i < chunks.length; i += 1) {
        const slot = await findOpenSlot({
          durationMinutes: chunks[i],
          deadline: args.deadline,
          earliestDate: earliest,
        });
        if (!slot) {
          await flagConflict(
            task.id,
            `Only ${scheduled.length}/${chunks.length} chunks of ${dur} min fit before ${args.deadline}.`,
          );
          return {
            task,
            chunks_planned: chunks,
            chunks_scheduled: scheduled,
            error: `Only ${scheduled.length} of ${chunks.length} chunks fit before the deadline. Ask what should give.`,
          };
        }
        scheduled.push(
          await insertBlock({
            source_type: "task",
            source_id: task.id,
            title: chunks.length > 1 ? `${task.name} (${i + 1}/${chunks.length})` : task.name,
            date: slot.date,
            start_time: slot.start_time,
            end_time: slot.end_time,
          }),
        );
        earliest = slot.date;
      }
      await db.tasks.update(task.id, { status: "scheduled", conflict_reason: null });
      return { task, chunks, scheduled };
    }

    case "add_assignment_part": {
      const query = String(args.assignment_query ?? "").trim();
      const date = String(args.date ?? "").trim();
      const start = String(args.start_time ?? "").trim();
      const end = String(args.end_time ?? "").trim();
      if (!query) return { error: "assignment_query is required" };
      if (!date || !start || !end) {
        return { error: "date, start_time and end_time are required — use upcoming_dates for tomorrow" };
      }
      const pd = pastDateError(date, "date");
      if (pd) return pd;
      const overlap = await fixedOverlapError(date, start, end);
      if (overlap) return overlap;

      const all = await db.tasks.toArray();
      let matches = all.filter((t) => matchesQuery(t.name, query)).slice(0, 5);
      if (matches.length === 0) {
        matches = all.filter((t) => matchesQuery(t.linked_class_or_project, query)).slice(0, 5);
      }
      if (matches.length === 0) {
        return { error: `No assignment matching "${query}" found. Create it first with add_assignment.` };
      }
      let task = matches[0];
      if (matches.length > 1) {
        const exact = matches.filter((t) => t.name.toLowerCase() === query.toLowerCase());
        if (exact.length === 1) task = exact[0];
        else {
          return {
            error: `Multiple assignments matching "${query}": ${matches.map((t) => `"${t.name}"`).join(", ")}. Ask which one.`,
          };
        }
      }
      if (task.deadline && date > task.deadline) {
        return {
          error: `That date ${date} is after the assignment's due date ${task.deadline}. Choose a date on or before the due date.`,
        };
      }

      const partTitle = String(args.part_name ?? "").trim() || task.name;
      const block = await insertBlock({
        source_type: "task",
        source_id: task.id,
        title: partTitle,
        date,
        start_time: start,
        end_time: end,
      });
      const outcome = await resolveConflicts(date, block, { urgent: ctx?.urgent === true });
      return {
        task,
        block,
        part_title: partTitle,
        conflicts_resolved: outcome.moved,
        conflicts_unresolved: outcome.unresolved,
        day_after_change: (await weekSchedule(date)).days.find((d) => d.date === date),
      };
    }

    case "flag_unresolvable_conflict":
      await flagConflict(args.task_id, args.reason);
      return { flagged: true, task_id: args.task_id, reason: args.reason };

    case "add_note_to_block": {
      const query = String(args.block_query ?? "").trim();
      const raw = String(args.raw_note ?? "").trim();
      if (!query) return { error: "block_query is required — substring of the commitment or block title" };
      if (!raw) return { error: "raw_note is required" };

      const summary = await summarizeNote(raw, ctx);
      const [commitments, blocks] = await Promise.all([
        db.fixed_commitments.toArray(),
        db.scheduled_blocks.toArray(),
      ]);

      const candidates: { kind: "fixed" | "block"; id: string; title: string; notes: string | null }[] = [
        ...commitments
          .filter((c) => matchesQuery(c.name, query))
          .slice(0, 5)
          .map((c: FixedCommitmentRow) => ({
            kind: "fixed" as const,
            id: c.id,
            title: c.name,
            notes: c.notes ?? null,
          })),
        ...blocks
          .filter((b) => matchesQuery(b.title, query))
          .slice(0, 5)
          .map((b: ScheduledBlockRow) => ({
            kind: "block" as const,
            id: b.id,
            title: b.title,
            notes: b.notes ?? null,
          })),
      ];

      if (candidates.length === 0) {
        return { error: `No block or commitment matching "${query}" found. Ask the user to clarify the name.` };
      }
      let target = candidates[0];
      if (candidates.length > 1) {
        const exact = candidates.filter((c) => c.title.toLowerCase() === query.toLowerCase());
        if (exact.length === 1) target = exact[0];
        else {
          return {
            error: `Multiple matches for "${query}": ${candidates.map((c) => `"${c.title}" (${c.kind})`).join(", ")}. Ask the user which one.`,
          };
        }
      }

      const next = target.notes ? `${target.notes}\n${summary}` : summary;
      if (target.kind === "fixed") await db.fixed_commitments.update(target.id, { notes: next });
      else await db.scheduled_blocks.update(target.id, { notes: next });

      return {
        target: { id: target.id, kind: target.kind, title: target.title, notes: summary },
        note_stored: summary,
      };
    }

    case "delete_block": {
      const query = String(args.block_query ?? "").trim();
      if (!query) return { error: "block_query is required" };

      const commitments = await db.fixed_commitments.toArray();
      const fixedHit = commitments.find((c) => matchesQuery(c.name, query));
      if (fixedHit) {
        if (args.confirmed !== true) {
          return {
            needs_confirmation: true,
            preview: `Cancel fixed commitment "${fixedHit.name}"? Say yes or tap Confirm`,
            fixed_commitment: fixedHit.name,
          };
        }
        return {
          error: `Cannot delete fixed commitment "${fixedHit.name}" via voice. Tell the user it's a fixed commitment they'd need to change under Fixed commitments.`,
        };
      }

      const dateHint = String(args.date ?? "").trim() || null;
      const startHint = timeHintToMinutes(args.start_time);
      const endHint = timeHintToMinutes(args.end_time);
      const hasTimeHint = startHint !== null || endHint !== null;

      const all = await db.scheduled_blocks.toArray();
      const rows = all
        .filter(
          (b) =>
            matchesQuery(b.title, query) &&
            (!dateHint || b.date === dateHint) &&
            overlapsTimeHint(b, startHint, endHint),
        )
        .slice(0, 5);
      if (rows.length === 0) {
        return { error: `No scheduled block matching "${query}"${dateHint ? ` on ${dateHint}` : ""} found.` };
      }

      let target = rows[0];
      if (rows.length > 1) {
        const exact = rows.filter((r) => r.title.toLowerCase() === query.toLowerCase());
        if (exact.length === 1) target = exact[0];
        else {
          return {
            error: `Multiple blocks matching "${query}": ${rows.map(formatBlockRef).join(", ")}. Ask which one (day and time).`,
          };
        }
      }
      // Fast path: title + date + time pin exactly one block — the user's
      // "remove math problems 4:30 to 6:30" is explicit enough to act on.
      const fastPath = rows.length === 1 && dateHint && hasTimeHint;
      if (args.confirmed !== true && !fastPath) {
        return {
          needs_confirmation: true,
          preview: `Delete "${target.title}" on ${target.date}? Say yes or tap Confirm`,
          block: { id: target.id, title: target.title, date: target.date },
        };
      }
      await db.scheduled_blocks.delete(target.id);
      return { deleted: true, fast_path: Boolean(fastPath && args.confirmed !== true), block: target };
    }

    case "reschedule_block": {
      const query = String(args.block_query ?? "").trim();
      const newDate = String(args.new_date ?? "").trim();
      const newStart = String(args.new_start_time ?? "").trim();
      const newEnd = String(args.new_end_time ?? "").trim();
      if (!query) return { error: "block_query is required" };
      if (!newDate || !newStart || !newEnd) {
        return { error: "new_date, new_start_time and new_end_time are required" };
      }
      const pd = pastDateError(newDate, "new_date");
      if (pd) return pd;
      const overlap = await fixedOverlapError(newDate, newStart, newEnd);
      if (overlap) return overlap;

      const commitments = await db.fixed_commitments.toArray();
      const fixedHit = commitments.find((c) => matchesQuery(c.name, query));
      if (fixedHit) {
        return {
          error: `Cannot reschedule fixed commitment "${fixedHit.name}" via voice. Tell the user it's a fixed commitment they'd need to change under Fixed commitments.`,
        };
      }

      const srcDate = String((args as any).date ?? "").trim() || null;
      const srcStart = timeHintToMinutes((args as any).start_time);
      const srcEnd = timeHintToMinutes((args as any).end_time);

      const all = await db.scheduled_blocks.toArray();
      const rows = all
        .filter(
          (b) =>
            matchesQuery(b.title, query) &&
            (!srcDate || b.date === srcDate) &&
            overlapsTimeHint(b, srcStart, srcEnd),
        )
        .slice(0, 5);
      if (rows.length === 0) return { error: `No scheduled block matching "${query}" found.` };

      let target = rows[0];
      if (rows.length > 1) {
        const exact = rows.filter((r) => r.title.toLowerCase() === query.toLowerCase());
        if (exact.length === 1) target = exact[0];
        else {
          return {
            error: `Multiple blocks matching "${query}": ${rows.map(formatBlockRef).join(", ")}. Ask which one (day and time).`,
          };
        }
      }

      // Checked once the target is known, so a block is never found to
      // clash with the very place it is moving out of.
      const eventClash = await eventOverlapError(newDate, newStart, newEnd, target.id);
      if (eventClash) return eventClash;

      await db.scheduled_blocks.update(target.id, {
        date: newDate,
        start_time: newStart,
        end_time: newEnd,
        previous_start_time: trimTime(target.start_time),
      });
      const updated = (await db.scheduled_blocks.get(target.id)) as ScheduledBlockRow;
      const outcome = await resolveConflicts(newDate, updated, { urgent: ctx?.urgent === true });
      return {
        block: updated,
        moved_from: `${target.date} ${trimTime(target.start_time)}`,
        conflicts_resolved: outcome.moved,
        conflicts_unresolved: outcome.unresolved,
        day_after_change: (await weekSchedule(newDate)).days.find((d) => d.date === newDate),
      };
    }

    case "set_task_status": {
      const q = String(args.task_query ?? "").trim().toLowerCase();
      const status = String(args.status ?? "").trim() as TaskRow["status"];
      if (!q) return { error: "task_query is required" };
      const all = await db.tasks.toArray();
      let matches = all.filter((t) => t.name.toLowerCase().includes(q));
      if (matches.length === 0) return { error: `No task matching "${args.task_query}"` };
      let task = matches[0];
      if (matches.length > 1) {
        const exact = matches.filter((t) => t.name.toLowerCase() === q);
        if (exact.length === 1) task = exact[0];
        else return { error: `Multiple tasks matching "${args.task_query}": ${matches.map((t) => `"${t.name}"`).join(", ")}. Ask which one.` };
      }
      await db.tasks.update(task.id, { status } as any);
      return { updated: true, task: { id: task.id, name: task.name, status } };
    }

    case "find_restaurant": {
      const venue = String(args.venue ?? "").trim();
      if (!venue) return { error: "venue is required — ask which place to book." };
      let area = String(args.area ?? "").trim();
      if (!area) {
        const remembered = await rememberedArea();
        if (remembered) area = remembered;
        else return { needs: ["area"], question: "Which city or neighbourhood?" };
      }
      return {
        venue,
        area,
        search_url: buildBookingSearchUrl({ venue, area, date: null, startTime: null, endTime: null, partySize: null }),
        hint: "Confirm the venue exists in that area before proposing. Never invent an address.",
      };
    }

    case "propose_booking": {
      const size = Number(args.party_size);
      const intent: BookingIntent = {
        venue: String(args.venue ?? "").trim() || null,
        area: String(args.area ?? "").trim() || null,
        date: String(args.date ?? "").trim() || null,
        startTime: String(args.start_time ?? "").trim() || null,
        endTime: String(args.end_time ?? "").trim() || null,
        partySize: Number.isFinite(size) && size > 0 ? Math.floor(size) : null,
      };
      if (!intent.area) intent.area = await rememberedArea();
      const missing = missingBookingSlots(intent);
      if (missing.length > 0) return { needs: missing, question: nextBookingQuestion(intent) };
      const date = intent.date as string;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parseISODate(date).getTime())) {
        return { error: "date must be a real YYYY-MM-DD date." };
      }
      const start = intent.startTime as string;
      if (!/^\d{1,2}:\d{2}$/.test(start)) return { error: "start_time must be HH:MM." };
      const end = intent.endTime && /^\d{1,2}:\d{2}$/.test(intent.endTime)
        ? intent.endTime
        : fromMinutes(minutesOf(start) + 90);
      const past = pastDateError(date, "date");
      if (past) return past;
      // A booking is an ordinary event: fixed commitments still always win.
      const fixedClash = await fixedOverlapError(date, start, end);
      if (fixedClash) return fixedClash;
      const eventClash = await eventOverlapError(date, start, end);
      if (eventClash) return eventClash;
      if (intent.area) await rememberArea(intent.area);
      const full = { ...intent, endTime: end };
      const hold = await insertBlock({
        source_type: "event",
        source_id: null,
        title: buildHoldTitle(full),
        date,
        start_time: start,
        end_time: end,
      });
      return {
        proposed: true,
        summary: formatProposal(full),
        hold_block_id: hold.id,
        search_url: buildBookingSearchUrl(full),
        next: "Read the summary to the user verbatim, then wait for yes or no. Only call book_appointment after an explicit yes, passing confirmed: true and this hold_block_id.",
      };
    }

    case "book_appointment": {
      // Safety — booking out in the world needs an explicit yes, with one fast path,
      // exactly like deletes. No confirmed flag, no booking. Ever.
      if (args.confirmed !== true) {
        const venue = String(args.venue ?? "").trim() || "that place";
        return {
          needs_confirmation: true,
          preview: `Book ${venue}? Say yes or tap Confirm — nothing books without it.`,
        };
      }
      const venue = String(args.venue ?? "").trim();
      const area = String(args.area ?? "").trim() || (await rememberedArea()) || "";
      const searchUrl = buildBookingSearchUrl({
        venue: venue || null,
        area: area || null,
        date: null,
        startTime: null,
        endTime: null,
        partySize: null,
      });
      const available = await isAgentAvailable().catch(() => false);
      // No agent window (plain browser): hand the booking page over instead.
      if (!available) {
        return {
          status: "needs_browser",
          hold_block_id: args.hold_block_id ?? null,
          deep_link: searchUrl,
          instruction:
            "No desktop agent window here. Give the user the link and the slot; they finish the booking by hand and the hold stays on their calendar.",
        };
      }
      // Desktop: drive the booking page in the visible agent window to
      // completion (capped: 10 steps, 2 minutes). The user watches every step;
      // the window stays open on every terminal state as proof or for takeover.
      const callModel = await liveModelCall().catch(() => null);
      if (!callModel) {
        return {
          status: "failed",
          hold_block_id: args.hold_block_id ?? null,
          deep_link: searchUrl,
          reason: "Add your browser key in Profile → Model first, then say yes again.",
        };
      }
      const size = Number(args.party_size);
      const intent: BookingIntent = {
        venue: venue || null,
        area: area || null,
        date: String(args.date ?? "").trim() || null,
        startTime: String(args.start_time ?? "").trim() || null,
        endTime: String(args.end_time ?? "").trim() || null,
        partySize: Number.isFinite(size) && size > 0 ? Math.floor(size) : null,
      };
      const result = await runBookingLoop({
        driver: {
          open: agentOpen,
          navigate: agentNavigate,
          snapshot: agentSnapshot,
          click: agentClick,
          type: agentType,
          close: agentClose,
        },
        model: callModel,
        intent,
        startUrl: searchUrl,
        holdBlockId: typeof args.hold_block_id === "string" ? args.hold_block_id : null,
        holds: {
          annotate: async (id: string, title: string) => {
            await db.scheduled_blocks.update(id, { title } as any);
          },
        },
      });
      return {
        ...result,
        speak:
          result.status === "booked"
            ? "Read the summary as the receipt, one short line."
            : result.status === "needs_user"
              ? "Relay the question verbatim — the booking page is open in front of the user."
              : "Say it didn't go through, give the deep link, and confirm the failed hold is still on their calendar.",
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Compact snapshot injected into the prompt so the model starts with context. */
/** The gaps left in a day once fixed commitments, buffers and blocks are out. */
function freeWindows(
  date: string,
  blocks: ScheduledBlockRow[],
  commitments: FixedCommitmentRow[],
  prefs: PreferencesRow,
): { start_time: string; end_time: string }[] {
  const dayStart = minutesOf(prefs.earliest_start_time);
  const dayEnd = minutesOf(prefs.latest_end_time);
  const busy = busyIntervals(date, blocks, commitments, prefs);

  const gaps: { start_time: string; end_time: string }[] = [];
  let cursor = dayStart;
  for (const interval of busy) {
    if (interval.start > cursor) {
      gaps.push({ start_time: fromMinutes(cursor), end_time: fromMinutes(Math.min(interval.start, dayEnd)) });
    }
    cursor = Math.max(cursor, interval.end);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) gaps.push({ start_time: fromMinutes(cursor), end_time: fromMinutes(dayEnd) });
  return gaps.filter((g) => minutesOf(g.end_time) > minutesOf(g.start_time));
}

const fromMinutes = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export async function contextSnapshot() {
  const today = toISODate(new Date());
  const [week, tasks, prefs, commitments, todayBlocks] = await Promise.all([
    weekSchedule(today),
    loadTasks(),
    loadPreferences(),
    loadCommitments(),
    loadBlocks(today, today),
  ]);

  const todayDay = week.days.find((d) => d.date === today);
  const todaySchedule = {
    date: today,
    weekday: WEEKDAY_LONG[parseISODate(today).getDay()],
    fixed_commitments: todayDay?.fixed_commitments ?? [],
    blocks: todayDay?.blocks ?? [],
    is_completely_free:
      (todayDay?.fixed_commitments.length ?? 0) === 0 && (todayDay?.blocks.length ?? 0) === 0,
    // Worked out by the scheduler's own busyIntervals, buffers included.
    // If a time sits inside one of these, it is free. Do not re-derive it.
    free_windows: freeWindows(today, todayBlocks, commitments.filter((c) => isActive(today, c)), prefs),
  };

  // Weekday name -> the next date with that name, so "Thursday" is never ambiguous.
  const upcoming: Record<string, string> = {};
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(today, i);
    upcoming[WEEKDAY_LONG[parseISODate(date).getDay()]] = date;
  }

  return {
    today,
    today_weekday: WEEKDAY_LONG[parseISODate(today).getDay()],
    tomorrow: addDays(today, 1),
    upcoming_dates: upcoming,
    now: new Date().toTimeString().slice(0, 5),
    week,
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      deadline: t.deadline,
      estimated_duration: t.estimated_duration,
      priority: t.priority,
      status: t.status,
    })),
    // Today, pre-resolved, plus the gaps worked out by the same code the
    // scheduler uses. The model repeatedly claimed a clash at a time that was
    // plainly empty, so it is no longer asked to work out what is free — it is
    // told. free_windows is authoritative; anything inside one is bookable.
    today_schedule: todaySchedule,
  };
}
