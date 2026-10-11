/**
 * 12-hour clock for everything Rocky says or shows in a reply: "8 PM",
 * "9:30 AM", "7 to 9 PM", "11 AM to 1 PM", "12 PM" (noon), "12 AM"
 * (midnight). The planner works in 24-hour HH:MM internally (tools, context);
 * this is the backstop that turns any 24-hour time or ISO date that still
 * reaches a reply into spoken form. Pure; tested in clockTalk.test.ts.
 */
import { addDays, parseISODate, toISODate, WEEKDAY_LONG } from "../../shared/datetime";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "19:00" -> "7 PM", "09:30" -> "9:30 AM", "12:00" -> "12 PM", "00:15" -> "12:15 AM". */
export function to12h(hhmm: string, withMeridiem = true): string {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const hour = h % 12 === 0 ? 12 : h % 12;
  const base = min ? `${hour}:${String(min).padStart(2, "0")}` : String(hour);
  return withMeridiem ? `${base} ${h < 12 ? "AM" : "PM"}` : base;
}

const meridiem = (hhmm: string) => (Number(hhmm.split(":")[0]) < 12 ? "AM" : "PM");

/** "19:00"-"21:00" -> "7 to 9 PM"; "11:00"-"13:00" -> "11 AM to 1 PM". */
export function range12h(start: string, end: string): string {
  return meridiem(start) === meridiem(end) ? `${to12h(start, false)} to ${to12h(end)}` : `${to12h(start)} to ${to12h(end)}`;
}

/**
 * Is "H:MM" a 24-hour time that must be converted? Yes when the hour is
 * 13-23, 0, has a leading zero ("07:00") or is 12 (noon in 24-hour use).
 * "7:30" with no AM/PM is left alone: it's already how people talk.
 */
function is24h(hourText: string): boolean {
  const h = Number(hourText);
  return h >= 12 || h === 0 || (hourText.length === 2 && hourText.startsWith("0"));
}

const TIME = String.raw`(\d{1,2}):([0-5]\d)(?::[0-5]\d)?`;
const NO_MERIDIEM = String.raw`(?!\s*(?:[ap]\.?m\b|o'?clock))`;

function spokenDate(iso: string, today: string): string {
  if (iso === today) return "today";
  if (iso === addDays(today, 1)) return "tomorrow";
  if (iso === addDays(today, -1)) return "yesterday";
  const d = parseISODate(iso);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return `${WEEKDAY_LONG[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

/** Every 24-hour time and ISO date in `text`, in spoken 12-hour form. */
export function speakableTimes(text: string, today: string = toISODate(new Date())): string {
  if (!text) return text;
  let out = text;
  // Ranges first: "19:00-21:00", "19:00–21:00", "19:00 to 21:00", "from 19:00 until 21:00".
  out = out.replace(new RegExp(String.raw`(?<![\d:])${TIME}\s*(?:-|–|—|to|until|till)\s*${TIME}${NO_MERIDIEM}`, "gi"), (all, h1, m1, h2, m2) =>
    is24h(h1) || is24h(h2) ? range12h(`${h1}:${m1}`, `${h2}:${m2}`) : all,
  );
  // Single times.
  out = out.replace(new RegExp(String.raw`(?<![\d:])${TIME}(?![\d:])${NO_MERIDIEM}`, "gi"), (all, h, m) => (is24h(h) ? to12h(`${h}:${m}`) : all));
  // ISO dates ("on 2026-10-12" -> "tomorrow", "on Friday, October 16").
  out = out.replace(/\b(on\s+)?(\d{4}-\d{2}-\d{2})\b/gi, (all: string, on: string | undefined, iso: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso)) return all;
    const said = spokenDate(iso, today);
    return on && /^(today|tomorrow|yesterday)$/.test(said) ? said : `${on ?? ""}${said}`;
  });
  return out;
}
