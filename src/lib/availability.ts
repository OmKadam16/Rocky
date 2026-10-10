/**
 * Proving, in code, that a requested time is free.
 *
 * The model has now claimed a phantom conflict five times in five different
 * shapes — most recently calling an 8pm meeting blocked by a lab that finished
 * at 17:50. Prompt rules and pre-computed free windows both help and neither is
 * a guarantee, because both still route through a model that can ignore them.
 *
 * So this parses what the user actually asked for and checks it against the
 * same free windows the scheduler produces. It is deliberately one-directional:
 * it can only ever prove a time IS free, never that it is taken. A parse it is
 * not sure about returns null and nothing changes. The worst case is that a
 * refusal goes through unchallenged, which is exactly today's behaviour.
 */

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

export type RequestedWindow = {
  date: string;
  start: string;
  /** null when they named a start but no end ("move it to seven"). */
  end: string | null;
};

export type DayWindows = { date: string; free_windows: { start_time: string; end_time: string }[] };

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/**
 * Words that promote the request to top priority: the new item is placed
 * first at the requested time and everything movable shifts around it.
 */
const URGENT_WORDS =
  /\b(?:urgent(?:ly)?|important(?:ly)?|critical(?:ly)?|asap|a\.s\.a\.p\.?|emergency|emergencies|priority|priorit(?:y|ise|ize)|must(?:-do)?|right\s+away|immediately|top\s+priority)\b/i;

export function detectUrgency(text: string): boolean {
  return URGENT_WORDS.test(text ?? "");
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/**
 * An hour, its minutes, and its am/pm if one was given, into minutes past
 * midnight. Returns null when the hour alone cannot be placed in the day —
 * "eight" is 08:00 or 20:00 and guessing is how this whole class of bug works.
 */
function resolveTime(hour: number, minute: number, meridiem: string | null): number | null {
  if (hour > 23 || minute > 59) return null;
  if (meridiem) {
    if (hour > 12 || hour === 0) return null;
    const h = meridiem.toLowerCase().startsWith("p") ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
    return h * 60 + minute;
  }
  // No am/pm. Only 12 and up can be placed without guessing — 12:30 is half
  // past noon (half past midnight would be written 12:30am), 13:15 is 24-hour.
  // One through eleven stays ambiguous, and ambiguous means we say nothing.
  if (hour >= 12) return hour * 60 + minute;
  return null;
}

/** Which part of the day the text names, or null. Tonight counts as evening. */
export function partOfDayIn(text: string): "morning" | "afternoon" | "evening" | "night" | null {
  const m = /\b(morning|afternoon|evening|night|tonight)\b/i.exec(text ?? "");
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w === "tonight" ? "evening" : (w as "morning" | "afternoon" | "evening" | "night");
}

/** Which day the user meant, or null if they never said. */
function resolveDate(
  text: string,
  ctx: { today: string; tomorrow: string; upcoming_dates: Record<string, string> },
): string | null {
  const t = text.toLowerCase();
  if (/\b(?:today|tonight|this evening|this afternoon|this morning)\b/.test(t)) return ctx.today;
  if (/\btomorrow\b/.test(t)) return ctx.tomorrow;
  for (const [name, date] of Object.entries(ctx.upcoming_dates)) {
    if (new RegExp(`\\b${name.toLowerCase()}\\b`).test(t)) return date;
  }
  // A bare weekday the upcoming map somehow missed.
  for (const name of WEEKDAYS) {
    if (new RegExp(`\\b${name}\\b`).test(t)) return null;
  }
  return null;
}

const RANGE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|\bto\b|\btill\b|\buntil\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;
const SINGLE = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
/** 24-hour only from noon on: "7:30" could be either half of the day. */
const SINGLE_24 = /\b(?:at\s+)?(1[2-9]|2[0-3]):([0-5]\d)\b/;

/**
 * "move it to 8-10pm today" -> { date, start: "20:00", end: "22:00" }.
 * Anything it cannot pin down exactly comes back null.
 */
export function parseRequestedWindow(
  text: string,
  ctx: { today: string; tomorrow: string; upcoming_dates: Record<string, string> },
): RequestedWindow | null {
  const date = resolveDate(text, ctx);
  if (!date) return null;

  const range = RANGE.exec(text);
  if (range) {
    const [, h1, m1, mer1, h2, m2, mer2] = range;
    // "8-10pm": the meridiem on the end applies to the start too.
    const startMer = mer1 ?? mer2 ?? null;
    const endMer = mer2 ?? mer1 ?? null;
    let start = resolveTime(Number(h1), Number(m1 ?? 0), startMer);
    let end = resolveTime(Number(h2), Number(m2 ?? 0), endMer);
    // Bare ranges like "4:30 to 6:30" carry no am/pm. A named part of day
    // decides the half: "morning 7" is 07:00, "evening 7" is 19:00.
    // Otherwise spoken times in the 1-11 band almost always mean
    // afternoon/evening, so infer pm rather than giving up. With an explicit
    // meridiem this branch never runs.
    if ((start === null || end === null) && !startMer && !endMer) {
      const anchor = partOfDayIn(text);
      const bare = (h: number, m: string | undefined) => {
        const hh = Number(h);
        if (hh < 1 || hh > 11) return null;
        const off = anchor === "morning" ? 0 : 12;
        return (hh + off) * 60 + Number(m ?? 0);
      };
      const ps = bare(Number(h1), m1);
      const pe = bare(Number(h2), m2);
      if (ps !== null && pe !== null && pe > ps && pe <= 24 * 60) {
        start = ps;
        end = pe;
      }
    }
    if (start === null || end === null) return null;
    // "8pm to 1" — the end rolled past noon into the next meridiem.
    if (end <= start && endMer && endMer.toLowerCase().startsWith("a")) return null;
    if (end <= start) end += 12 * 60;
    if (end <= start || end > 24 * 60) return null;
    return { date, start: fmt(start), end: fmt(end) };
  }

  const single = SINGLE.exec(text);
  if (single) {
    const start = resolveTime(Number(single[1]), Number(single[2] ?? 0), single[3]);
    return start === null ? null : { date, start: fmt(start), end: null };
  }

  const single24 = SINGLE_24.exec(text);
  if (single24) {
    const start = Number(single24[1]) * 60 + Number(single24[2]);
    return { date, start: fmt(start), end: null };
  }

  // Bare single like "math problems 4:30" — infer pm (16:30), or am when
  // the text names the morning ("yoga at 7 in the morning" → 07:00).
  const bareSingle = /\b(?:at\s+)?([1-9]|1[0-1]):([0-5]\d)\b/i.exec(text);
  if (bareSingle) {
    const off = partOfDayIn(text) === "morning" ? 0 : 12;
    const start = (Number(bareSingle[1]) + off) * 60 + Number(bareSingle[2]);
    if (start < 24 * 60) return { date, start: fmt(start), end: null };
  }

  // Bare hour carried by a part of day, no colon: "yoga at 7 in the morning"
  // → 07:00, "party at 7 in the evening" → 19:00.
  const anchorHour =
    /\b(morning|afternoon|evening|night|tonight)\b[^.\n]{0,24}?\b([1-9]|1[0-1])\b|\b([1-9]|1[0-1])\s*(?:o'?clock\s+)?in\s+the\s+(morning|afternoon|evening|night)\b/i.exec(
      text,
    );
  if (anchorHour) {
    const anchorWord = (anchorHour[1] ?? anchorHour[4] ?? "").toLowerCase();
    const hour = Number(anchorHour[2] ?? anchorHour[3]);
    const off = anchorWord === "morning" ? 0 : 12;
    const start = (hour + off) * 60;
    if (start < 24 * 60) return { date, start: fmt(start), end: null };
  }

  return null;
}

/**
 * True only when the whole requested window sits inside one free window on that
 * day. Absence of proof is not proof of a clash — false just means "unknown".
 */
export function isProvablyFree(window: RequestedWindow, days: DayWindows[]): boolean {
  const day = days.find((d) => d.date === window.date);
  if (!day || !day.free_windows?.length) return false;
  const start = toMinutes(window.start);
  const end = window.end ? toMinutes(window.end) : null;
  return day.free_windows.some((w) => {
    const ws = toMinutes(w.start_time);
    const we = toMinutes(w.end_time);
    return end === null ? start >= ws && start < we : start >= ws && end <= we;
  });
}

/** The day's gaps, spoken plainly, for a corrective message. */
export function describeFree(date: string, days: DayWindows[]): string {
  const day = days.find((d) => d.date === date);
  if (!day || !day.free_windows?.length) return "nothing";
  return day.free_windows.map((w) => `${w.start_time}-${w.end_time}`).join(", ");
}

/* ------------------------------------------------------------------ *
 * Holding the model to a time the user actually named.
 * ------------------------------------------------------------------ */

/** Verbs that turn "from 8pm to 10pm" into a move, not a window. */
const MOVE_VERB = /\b(?:move|shift|reschedul\w*|push|bump|change)\b/i;
const FROM_RANGE = /\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|\bto\b)/i;
/** Any time-of-day expression, to spot a message naming more than one. */
const ANY_TIME = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\b(?:1[2-9]|2[0-3]):[0-5]\d\b|\b(?:[1-9]|1[0-1]):[0-5]\d\b/gi;

/**
 * The window the user named, but only when it is safe to hold the model to it.
 *
 * Stricter than parseRequestedWindow, because this one overrules the model
 * rather than merely informing it. Two cases are refused outright:
 * "move it from 8pm to 10pm", where the range is a journey and not a window,
 * and any message naming several times, where there is no single right answer.
 */
export function explicitWindow(
  text: string,
  ctx: { today: string; tomorrow: string; upcoming_dates: Record<string, string> },
): RequestedWindow | null {
  if (MOVE_VERB.test(text) && FROM_RANGE.test(text)) return null;
  const mentions = text.match(ANY_TIME) ?? [];
  const window = parseRequestedWindow(text, ctx);
  if (!window) return null;
  // A range legitimately mentions two; anything beyond that is a message we
  // cannot pin to one booking.
  if (mentions.length > (window.end ? 2 : 1)) return null;
  return window;
}

const SLOT_ARGS: Record<string, { date: string; start: string; end: string }> = {
  add_one_off_event: { date: "date", start: "start_time", end: "end_time" },
  add_assignment_part: { date: "date", start: "start_time", end: "end_time" },
  reschedule_block: { date: "new_date", start: "new_start_time", end: "new_end_time" },
  move_task_to_slot: { date: "new_date", start: "new_start_time", end: "new_end_time" },
};

/**
 * Checks a pending tool call against the time the user gave. Returns a message
 * for the model when the call disagrees, or null to let it through.
 *
 * The user asked for a block from 8pm to 10pm and got 18:15-20:15 — the model
 * went looking for the earliest gap instead of using the time it was handed.
 * A named time is not a preference to be optimised around.
 */
export function enforceExplicitTime(
  name: string,
  args: Record<string, unknown>,
  want: RequestedWindow,
): string | null {
  if (name === "find_open_slot") {
    return want.end
      ? `The user named an exact time: ${want.start} to ${want.end} on ${want.date}. Do not search for a slot — book that window.`
      : `The user named an exact start: ${want.start} on ${want.date}. Do not search for a slot — start there.`;
  }

  const keys = SLOT_ARGS[name];
  if (!keys) return null;

  const date = typeof args[keys.date] === "string" ? (args[keys.date] as string) : null;
  const start = typeof args[keys.start] === "string" ? (args[keys.start] as string) : null;
  if (!start) return null;

  const wrongDay = date !== null && date !== want.date;
  const wrongStart = start.slice(0, 5) !== want.start;
  if (!wrongDay && !wrongStart) return null;

  const asked = want.end ? `${want.start} to ${want.end}` : `${want.start}`;
  return (
    `You are about to book ${date ?? "that day"} at ${start}, but the user asked for ${asked} on ${want.date}. ` +
    `That time is theirs to choose, not yours to optimise. Call ${name} again with ${keys.date} ${want.date}` +
    (want.end
      ? `, ${keys.start} ${want.start} and ${keys.end} ${want.end}.`
      : `, ${keys.start} ${want.start}, keeping the same duration.`) +
    ` If it genuinely cannot go there, say so plainly instead of quietly moving it.`
  );
}
