/**
 * Booking Agent v2: what to book, as pure logic (no DOM, no Electron).
 *
 * Three task types share the common slots and add their own. The planner
 * fills a draft one question at a time, reads the full plan back, and only on
 * an explicit yes hands it to the agent (electron/agentCore.cjs), which drives
 * the real booking page.
 *
 * Known facts come from the profile: display_name and the account email are
 * offered, not asked cold. Phone and home city are remembered in profile
 * `extra` (no migration) only after the user gave them once.
 */
import { db } from "./db";

export type TaskType = "restaurant" | "appointment" | "tickets";
export const TASK_TYPES: TaskType[] = ["restaurant", "appointment", "tickets"];

/** Browser worker model. The planner never uses these, and never reads browser_key. */
export const BROWSER_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;
export type BrowserModel = (typeof BROWSER_MODELS)[number];
export const DEFAULT_BROWSER_MODEL: BrowserModel = "gpt-5.5";
const BROWSER_MODEL_KEY = "vc-browser-model";

export function browserModel(): BrowserModel {
  try {
    const v = localStorage.getItem(BROWSER_MODEL_KEY);
    if (v && (BROWSER_MODELS as readonly string[]).includes(v)) return v as BrowserModel;
  } catch {
    /* no storage: default */
  }
  return DEFAULT_BROWSER_MODEL;
}

export function setBrowserModel(m: BrowserModel) {
  try {
    localStorage.setItem(BROWSER_MODEL_KEY, m);
  } catch {
    /* best effort */
  }
}

export type BookingDraft = {
  type: TaskType;
  venue: string | null;
  /** City / neighbourhood. Asked, never GPS. */
  area: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** HH:MM 24h */
  startTime: string | null;
  /** HH:MM 24h */
  endTime: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  /** A booking page the user named. Otherwise the agent searches. */
  siteUrl: string | null;
  // restaurant
  partySize: number | null;
  /** Optional, asked once: "none" counts as answered. */
  occasion: string | null;
  // appointment
  service: string | null;
  staff: string | null;
  duration: string | null;
  // tickets
  event: string | null;
  quantity: number | null;
  seats: string | null;
  maxPrice: string | null;
};

export const EMPTY_DRAFT: BookingDraft = {
  type: "restaurant",
  venue: null,
  area: null,
  date: null,
  startTime: null,
  endTime: null,
  firstName: null,
  lastName: null,
  phone: null,
  email: null,
  siteUrl: null,
  partySize: null,
  occasion: null,
  service: null,
  staff: null,
  duration: null,
  event: null,
  quantity: null,
  seats: null,
  maxPrice: null,
};

export type SlotKey =
  | "venue"
  | "area"
  | "date"
  | "time"
  | "partySize"
  | "service"
  | "event"
  | "quantity"
  | "seats"
  | "maxPrice"
  | "first_name"
  | "last_name"
  | "phone"
  | "email"
  | "occasion";

const QUESTIONS: Record<SlotKey, string> = {
  venue: "Which place should I book?",
  area: "Which city or neighbourhood?",
  date: "Which day?",
  time: "What time?",
  partySize: "How many people?",
  service: "Which service do you want?",
  event: "Which event?",
  quantity: "How many tickets?",
  seats: "Any seat or section preference? Say any if not.",
  maxPrice: "What's the most you want to pay per ticket?",
  first_name: "What first name should the booking go under?",
  last_name: "And the last name?",
  phone: "What phone number should I put down?",
  email: "What email should I put down?",
  occasion: "Is this for an occasion? Say none if not.",
};

const blank = (v: unknown) => v == null || (typeof v === "string" && !v.trim()) || (typeof v === "number" && !(v > 0));

/** Slots per type, in the order they're asked. Common slots wrap the type's own. */
const TYPE_SLOTS: Record<TaskType, SlotKey[]> = {
  restaurant: ["partySize"],
  appointment: ["service"],
  tickets: ["event", "quantity", "seats", "maxPrice"],
};

const VALUE: Record<SlotKey, (d: BookingDraft) => unknown> = {
  venue: (d) => d.venue,
  area: (d) => d.area,
  date: (d) => d.date,
  time: (d) => d.startTime,
  partySize: (d) => d.partySize,
  service: (d) => d.service,
  event: (d) => d.event,
  quantity: (d) => d.quantity,
  seats: (d) => d.seats,
  maxPrice: (d) => d.maxPrice,
  first_name: (d) => d.firstName,
  last_name: (d) => d.lastName,
  phone: (d) => d.phone,
  email: (d) => d.email,
  occasion: (d) => d.occasion,
};

export function requiredSlots(type: TaskType): SlotKey[] {
  const tail: SlotKey[] = ["first_name", "last_name", "phone", "email"];
  // Occasion is restaurant-only and optional: asked once, "none" answers it.
  return ["venue", "area", "date", "time", ...TYPE_SLOTS[type], ...tail, ...(type === "restaurant" ? (["occasion"] as SlotKey[]) : [])];
}

/** Missing slots in ask order. Never includes something already known. */
export function missingSlots(d: BookingDraft): SlotKey[] {
  return requiredSlots(d.type).filter((k) => blank(VALUE[k](d)));
}

/** Facts Rocky already has: offered as a yes/no, never asked cold. */
export type KnownFacts = {
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  /** Given (or confirmed) by the user in an earlier booking: reused without asking. */
  bookingFirstName?: string | null;
  bookingLastName?: string | null;
  bookingEmail?: string | null;
};

/**
 * Contact details the user already gave Rocky for a booking (name, phone,
 * email) go straight into a new draft instead of being asked again. They
 * still appear in the plan read back before anything is booked, so a wrong
 * one costs one correction, not a round of questions.
 */
export function fillKnown(d: BookingDraft, known: KnownFacts = {}): BookingDraft {
  const next = { ...d };
  if (!next.firstName && !next.lastName && known.bookingFirstName?.trim() && known.bookingLastName?.trim()) {
    next.firstName = known.bookingFirstName.trim();
    next.lastName = known.bookingLastName.trim();
  }
  if (!next.phone && known.phone?.trim()) next.phone = known.phone.trim();
  if (!next.email && known.bookingEmail?.trim()) next.email = known.bookingEmail.trim();
  return next;
}

export function splitName(name: string | null | undefined): { first: string; last: string } | null {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** The single next question (ONE per turn), or null when the draft is complete. */
export function nextQuestion(d: BookingDraft, known: KnownFacts = {}): { slot: SlotKey; question: string; suggestion?: string } | null {
  const [slot] = missingSlots(d);
  if (!slot) return null;
  const name = splitName(known.displayName);
  if ((slot === "first_name" || slot === "last_name") && name && !d.firstName && !d.lastName) {
    return { slot, question: `Should I book it under ${name.first} ${name.last}?`, suggestion: `${name.first} ${name.last}` };
  }
  if (slot === "email" && known.email?.trim()) {
    return { slot, question: `Use ${known.email.trim()} for the booking email?`, suggestion: known.email.trim() };
  }
  if (slot === "phone" && known.phone?.trim()) {
    return { slot, question: `Use ${known.phone.trim()} for the phone number?`, suggestion: known.phone.trim() };
  }
  if (slot === "area" && known.city?.trim()) {
    return { slot, question: `In ${known.city.trim()}?`, suggestion: known.city.trim() };
  }
  if (slot === "venue" && d.type === "appointment") return { slot, question: "Where should I book it? The business name is enough." };
  return { slot, question: QUESTIONS[slot] };
}

const spokenDay = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { weekday: "long" });
};

export const spokenTime = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return time;
  let h = Number(m[1]);
  const mins = m[2];
  const suffix = h >= 12 ? "pm" : "am";
  h = h % 12 === 0 ? 12 : h % 12;
  return mins === "00" ? `${h}${suffix}` : `${h}:${mins}${suffix}`;
};

const when = (d: BookingDraft) =>
  d.date && d.startTime ? `${spokenDay(d.date)} ${spokenTime(d.startTime)}` : (d.date ?? d.startTime ?? "that time");

const what = (d: BookingDraft) => {
  if (d.type === "restaurant") return `Table at ${d.venue ?? "the restaurant"}`;
  if (d.type === "appointment") return `${d.service ? cap(d.service) : "Appointment"} at ${d.venue ?? "the business"}`;
  return `${d.quantity ?? ""} ${d.quantity === 1 ? "ticket" : "tickets"} for ${d.event ?? d.venue ?? "the event"}`.trim();
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Confirmation #1: the full plan, read back before anything is driven.
 * "Haircut at Fade Co, Saturday 3pm, name Om Kadam, phone ..., email ...".
 */
export function formatPlan(d: BookingDraft): string {
  const parts = [`${what(d)}${d.area ? ` in ${d.area}` : ""}`, when(d)];
  if (d.type === "restaurant" && d.partySize) parts.push(`for ${d.partySize}`);
  if (d.type === "appointment" && d.staff) parts.push(`with ${d.staff}`);
  if (d.type === "tickets") {
    if (d.seats && !/^any/i.test(d.seats)) parts.push(`seats: ${d.seats}`);
    if (d.maxPrice) parts.push(`up to ${d.maxPrice} each`);
  }
  parts.push(`name ${[d.firstName, d.lastName].filter(Boolean).join(" ")}`);
  if (d.phone) parts.push(`phone ${d.phone}`);
  if (d.email) parts.push(`email ${d.email}`);
  if (d.type === "restaurant" && d.occasion && !/^(none|no|nope|n\/a)$/i.test(d.occasion.trim())) parts.push(`occasion: ${d.occasion}`);
  const pay = d.type === "tickets" ? " I'll stop at the payment page for you to pay." : "";
  return `${parts.join(", ")}.${pay} Say yes or tap Confirm and I'll start.`;
}

/** Calendar hold title while the booking is in flight. */
export function buildHoldTitle(d: BookingDraft): string {
  const lead = d.type === "tickets" ? (d.event ?? d.venue ?? "Tickets") : d.type === "appointment" && d.service ? `${cap(d.service)} — ${d.venue ?? ""}`.replace(/ — $/, "") : (d.venue ?? "Booking");
  const extra = d.type === "restaurant" && d.partySize ? ` — ${d.partySize}` : d.type === "tickets" && d.quantity ? ` — ${d.quantity}` : "";
  return `${lead}${extra} (booking…)`;
}

export const HOLD_MARK = "(booking…)";

export function finalHoldTitle(holdTitle: string, outcome: "booked" | "failed" | "unclear", reference?: string | null): string {
  const base = holdTitle.replace(/\s*\((booking…|booked[^)]*|booking failed[^)]*|check booking[^)]*)\)\s*$/, "").trim();
  if (outcome === "booked") return `${base} (booked${reference ? ` · ${reference}` : ""})`;
  if (outcome === "unclear") return `${base} (check booking — not confirmed)`;
  return `${base} (booking failed - finish by hand)`;
}

/** Where the agent starts: the named site, else a search it picks from. */
export function startUrlFor(d: Pick<BookingDraft, "siteUrl" | "venue" | "area" | "event" | "type">): string {
  if (d.siteUrl && /^https?:\/\//i.test(d.siteUrl.trim())) return d.siteUrl.trim();
  const q = [d.type === "tickets" ? (d.event ?? d.venue) : d.venue, d.area, d.type === "tickets" ? "tickets" : "book"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** A bare domain the user said ("fadeco.com") becomes an https URL; anything else is ignored. */
export function normalizeSiteUrl(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return `https://${s}`;
  return null;
}

/** The task object the main-process agent accepts (see normalizeTask in agentCore.cjs). */
export type AgentTask = {
  type: TaskType;
  venue: string;
  area: string;
  date: string;
  time: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  details: Record<string, string>;
  startUrl: string;
  holdBlockId: string | null;
  model: BrowserModel;
};

export function toAgentTask(d: BookingDraft, holdBlockId: string | null, model: BrowserModel = browserModel()): AgentTask {
  const details: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (!blank(v)) details[k] = String(v);
  };
  if (d.type === "restaurant") {
    put("partySize", d.partySize);
    if (d.occasion && !/^(none|no|nope|n\/a)$/i.test(d.occasion.trim())) put("occasion", d.occasion);
  } else if (d.type === "appointment") {
    put("service", d.service);
    put("staff", d.staff);
    put("duration", d.duration);
  } else {
    put("event", d.event);
    put("quantity", d.quantity);
    put("seats", d.seats);
    put("maxPrice", d.maxPrice);
  }
  return {
    type: d.type,
    venue: d.venue ?? "",
    area: d.area ?? "",
    date: d.date ?? "",
    time: d.endTime && d.startTime ? `${d.startTime} (window until ${d.endTime})` : (d.startTime ?? ""),
    firstName: d.firstName ?? "",
    lastName: d.lastName ?? "",
    phone: d.phone ?? "",
    email: d.email ?? "",
    details,
    startUrl: startUrlFor(d),
    holdBlockId,
    model,
  };
}

// ---------------------------------------------------------------------------
// Words the code itself checks (never the model): the two confirmations and
// the takeover hand-back.
// ---------------------------------------------------------------------------

const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|go ahead|do it|book it|please do|go for it|sounds good)\b[\s.!,]*(please|thanks)?[\s.!]*$/i;
const NO = /^\s*(no|nope|nah|don'?t|do not|cancel|never ?mind|not now)\b/i;
const STOP = /^\s*(stop|stop it|halt|abort|cancel( it| the booking)?|forget it|never ?mind)\s*[.!]*$/i;
const CONTINUE = /^\s*(continue|carry on|go on|keep going|resume|done|i'?m done|finished|all done|ok(ay)? (i'?m )?done|i did it)\s*[.!]*$/i;

export const isExplicitYes = (text: string | null | undefined) => YES.test(String(text ?? ""));
export const isExplicitNo = (text: string | null | undefined) => NO.test(String(text ?? "")) && !YES.test(String(text ?? ""));
/**
 * A go-ahead to something Rocky just read back: "yes", "yes, make the
 * appointment", "just book it", "go ahead and reserve it", "just use it".
 * Anything that changes or doubts the plan ("yes but at 9", "no", "for 4",
 * "wait") is not one, and goes to the planner instead.
 */
export function isGoAhead(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80) return false;
  if (/\b(no|nope|nah|not|don'?t|but|change|instead|actually|wait|different|another|cancel|stop|later|earlier|hold on|rather|except)\b|\d/.test(t)) return false;
  if (YES.test(t)) return true;
  return /^(yes|yeah|yep|yup|sure|ok|okay|alright|please|just|go ahead|go for it|do it|go|book|make|reserve|start|confirm|confirmed|sounds good|perfect|correct|that's right|thats right|let's do it|lets do it|use it)\b/.test(t);
}

export const isStop = (text: string | null | undefined) => STOP.test(String(text ?? ""));
export const isContinue = (text: string | null | undefined) => CONTINUE.test(String(text ?? ""));

// ---------------------------------------------------------------------------
// Remembered facts (profile `extra`, no migration). Name, phone, email and
// city are only written after the user gave (or confirmed) them in a booking,
// and are saved as soon as they're given, not only when a plan completes.
// ---------------------------------------------------------------------------

type ProfileExtra = {
  email?: string | null;
  display_name?: string | null;
  booking_phone?: string | null;
  home_city?: string | null;
  booking_first_name?: string | null;
  booking_last_name?: string | null;
  booking_email?: string | null;
};

export async function knownFacts(): Promise<KnownFacts> {
  try {
    const p = (await db.profiles.get("local")) as unknown as ProfileExtra | undefined;
    return {
      displayName: p?.display_name?.trim() || null,
      email: p?.email?.trim() || null,
      phone: p?.booking_phone?.trim() || null,
      city: p?.home_city?.trim() || null,
      bookingFirstName: p?.booking_first_name?.trim() || null,
      bookingLastName: p?.booking_last_name?.trim() || null,
      bookingEmail: p?.booking_email?.trim() || null,
    };
  } catch {
    return {};
  }
}

export async function rememberFacts(facts: {
  phone?: string | null;
  city?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): Promise<void> {
  const patch: Record<string, string> = {};
  if (facts.phone?.trim()) patch.booking_phone = facts.phone.trim();
  if (facts.city?.trim()) patch.home_city = facts.city.trim();
  // Name only as a pair, so a half-given name never overwrites a whole one.
  if (facts.firstName?.trim() && facts.lastName?.trim()) {
    patch.booking_first_name = facts.firstName.trim();
    patch.booking_last_name = facts.lastName.trim();
  }
  if (facts.email?.trim() && /@/.test(facts.email)) patch.booking_email = facts.email.trim();
  if (!Object.keys(patch).length) return;
  try {
    const p = ((await db.profiles.get("local")) ?? { id: "local" }) as unknown as Record<string, unknown>;
    if (Object.entries(patch).every(([k, v]) => p[k] === v)) return;
    await db.profiles.put({ ...p, id: "local", ...patch } as never);
  } catch {
    /* remembering is best-effort; the booking must not fail over it */
  }
}
