/**
 * Browser booking agent — pure logic (no DOM, no Electron).
 *
 * The agent books appointments (restaurant-first) on the user's behalf:
 * slot-fill the intent one question at a time, hold the time on the calendar,
 * then drive the venue's booking page in the desktop agent window.
 *
 * Key routing: the worker model (GPT-5.4-mini, cheap) always runs on
 * `browser_key` — never `llm_key` — so demo turns can't burn browser budget.
 * The Electron driver lives in `browserDriver.ts`; the planner tools that call
 * into this module live in `plannerTools.ts`.
 */
import OpenAI from "openai";
import { db } from "./db";
import { getSecret } from "./secrets";

/** The cheap computer-use worker. Full GPT-5.4 only if the mini fumbles. */
export const BROWSER_MODEL = "gpt-5.4-mini";

export type BookingIntent = {
  venue: string | null;
  /** City / neighbourhood, e.g. "Bandra West, Mumbai". Asked, never GPS. */
  area: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** HH:MM 24h */
  startTime: string | null;
  /** HH:MM 24h */
  endTime: string | null;
  partySize: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
};

export const EMPTY_INTENT: BookingIntent = {
  venue: null,
  area: null,
  date: null,
  startTime: null,
  endTime: null,
  partySize: null,
};

type SlotKey = "venue" | "area" | "date" | "time" | "partySize";

const SLOT_QUESTIONS: Record<SlotKey, string> = {
  venue: "Which place should I book?",
  area: "Which city or neighbourhood?",
  date: "Which day?",
  time: "What time?",
  partySize: "How many people?",
};

/** Missing slots in the order they must be asked — one question per turn. */
export function missingBookingSlots(intent: BookingIntent): SlotKey[] {
  const missing: SlotKey[] = [];
  if (!intent.venue?.trim()) missing.push("venue");
  if (!intent.area?.trim()) missing.push("area");
  if (!intent.date?.trim()) missing.push("date");
  if (!intent.startTime?.trim()) missing.push("time");
  if (intent.partySize == null || intent.partySize < 1) missing.push("partySize");
  return missing;
}

/** The single next question, or null when the intent is complete. */
export function nextBookingQuestion(intent: BookingIntent): string | null {
  const [first] = missingBookingSlots(intent);
  return first ? SLOT_QUESTIONS[first] : null;
}

export function isBookingComplete(intent: BookingIntent): boolean {
  return missingBookingSlots(intent).length === 0;
}

const spokenDay = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { weekday: "long" });
};

const spokenTime = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return time;
  let h = Number(m[1]);
  const mins = m[2];
  const suffix = h >= 12 ? "pm" : "am";
  h = h % 12 === 0 ? 12 : h % 12;
  return mins === "00" ? `${h}${suffix}` : `${h}:${mins}${suffix}`;
};

/** One short spoken line proposing the booking — read aloud before confirming. */
export function formatProposal(intent: BookingIntent): string {
  const when = intent.date && intent.startTime
    ? `${spokenDay(intent.date)} at ${spokenTime(intent.startTime)}`
    : intent.date ?? intent.startTime ?? "that time";
  const party = intent.partySize ? ` for ${intent.partySize}` : "";
  return `${intent.venue ?? "It"} ${when}${party} — say yes or tap Confirm and I'll book it.`;
}

/** Calendar hold title, e.g. "Nobu — 2, Fri 7:30pm (booking…)". */
export function buildHoldTitle(intent: BookingIntent): string {
  const party = intent.partySize ? ` — ${intent.partySize}` : "";
  const when = intent.date && intent.startTime
    ? `, ${spokenDay(intent.date).slice(0, 3)} ${spokenTime(intent.startTime)}`
    : "";
  return `${intent.venue ?? "Booking"}${party}${when} (booking…)`;
}

/** Fallback deep link when there is no agent window (browser users). */
export function buildBookingSearchUrl(intent: BookingIntent): string {
  const q = [intent.venue, intent.area, "book a table"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** The remembered home city, stored in profile `extra` (no migration). */
export async function rememberedArea(): Promise<string | null> {
  try {
    const p = (await db.profiles.get("local")) as unknown as { home_city?: string | null } | undefined;
    const v = p?.home_city?.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

export async function rememberArea(area: string): Promise<void> {
  const v = area.trim();
  if (!v) return;
  try {
    const p = ((await db.profiles.get("local")) ?? { id: "local" }) as Record<string, unknown>;
    await db.profiles.put({ ...p, id: "local", home_city: v } as never);
  } catch {
    /* remembering is best-effort; the booking must not fail over it */
  }
}

// ---------------------------------------------------------------------------
// Worker step: one GPT-5.4-mini decision on a page snapshot.
// The multi-round loop (snapshot -> act -> snapshot ...) runs in the booking
// runner; this function is deliberately single-step so it stays unit-testable.
// ---------------------------------------------------------------------------

export type PageSnapshot = {
  url: string;
  title: string;
  /** Visible text, truncated by the driver. */
  text: string;
};

export type AgentAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "snapshot" }
  | { kind: "done"; summary: string }
  | { kind: "ask_user"; question: string };

/** Minimal model-call shape so tests can stub the network. */
export type ModelCall = (messages: { role: string; content: string }[]) => Promise<string>;

const AGENT_SYSTEM = `You drive a restaurant booking page for the user. Reply with exactly one JSON action, no other text:
{"kind":"navigate","url":"https://…"} — go to a booking/search page (http(s) only)
{"kind":"click","selector":"CSS selector"} — click a book/reserve/availability element
{"kind":"type","selector":"CSS selector","text":"…"} — fill a name/date/party field
{"kind":"snapshot"} — the page changed and you need a fresh look
{"kind":"done","summary":"Booked Nobu Fri 7:30pm for 2, ref ABC123"} — booking completed on the page
{"kind":"ask_user","question":"…"} — you need info only the user has (phone number, seating choice)
Never invent a confirmation reference. Only "done" when the page itself shows the booking succeeded.`;

export function buildAgentMessages(snapshot: PageSnapshot, intent: BookingIntent): { role: string; content: string }[] {
  return [
    { role: "system", content: AGENT_SYSTEM },
    {
      role: "user",
      content: `Booking: ${JSON.stringify(intent)}\nPage: ${snapshot.url} — ${snapshot.title}\n${snapshot.text}`,
    },
  ];
}

export function parseAgentAction(raw: string): AgentAction {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON");
    const a = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    switch (a.kind) {
      case "navigate":
        if (typeof a.url === "string" && /^https?:\/\//.test(a.url)) return { kind: "navigate", url: a.url };
        break;
      case "click":
        if (typeof a.selector === "string" && a.selector) return { kind: "click", selector: a.selector };
        break;
      case "type":
        if (typeof a.selector === "string" && a.selector && typeof a.text === "string") {
          return { kind: "type", selector: a.selector, text: a.text };
        }
        break;
      case "snapshot":
        return { kind: "snapshot" };
      case "done":
        if (typeof a.summary === "string" && a.summary.trim()) return { kind: "done", summary: a.summary.trim() };
        break;
      case "ask_user":
        if (typeof a.question === "string" && a.question.trim()) return { kind: "ask_user", question: a.question.trim() };
        break;
    }
  } catch {
    /* fall through to the safe default */
  }
  // Anything unparseable or unsafe becomes a user question, never an action.
  // A wrong click on a booking page is worse than a clarification.
  return { kind: "ask_user", question: "The booking page isn't cooperating — want me to open it for you to finish by hand?" };
}

export async function nextAgentAction(callModel: ModelCall, snapshot: PageSnapshot, intent: BookingIntent): Promise<AgentAction> {
  const raw = await callModel(buildAgentMessages(snapshot, intent));
  return parseAgentAction(raw);
}

/** OpenAI client on the browser key. Null when the key is missing. */
export async function browserClient(): Promise<OpenAI | null> {
  const key = (await getSecret("browser_key").catch(() => null))?.trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: "https://api.openai.com/v1", dangerouslyAllowBrowser: true });
}

/** One live worker step on the real key (used by the runner, not the planner). */
export async function liveAgentStep(snapshot: PageSnapshot, intent: BookingIntent): Promise<AgentAction> {
  const client = await browserClient();
  if (!client) return { kind: "ask_user", question: "Add your browser key in Profile → Model first." };
  const raw = await client.chat.completions.create({
    model: BROWSER_MODEL,
    messages: buildAgentMessages(snapshot, intent) as never,
  });
  return parseAgentAction(raw.choices[0]?.message?.content ?? "");
}

/** A ModelCall bound to the real browser key. Null when the key is missing. */
export async function liveModelCall(): Promise<ModelCall | null> {
  const client = await browserClient().catch(() => null);
  if (!client) return null;
  return async (messages) => {
    const raw = await client.chat.completions.create({ model: BROWSER_MODEL, messages: messages as never });
    return raw.choices[0]?.message?.content ?? "";
  };
}

// ---------------------------------------------------------------------------
// Drive loop: snapshot -> worker -> act, until booked, blocked, or capped.
// Runs in the renderer and drives the desktop agent window over IPC, so the
// user watches every step. Terminal states always annotate the calendar hold
// (when there is one) and always leave the window open — proof stays visible,
// and the user can take over from any failed or blocked state.
// ---------------------------------------------------------------------------

/** The IPC driver, injected so tests can stub the window. */
export type LoopDriver = {
  open: () => Promise<void>;
  navigate: (url: string) => Promise<PageSnapshot>;
  snapshot: () => Promise<PageSnapshot>;
  click: (selector: string) => Promise<PageSnapshot>;
  type: (selector: string, text: string) => Promise<PageSnapshot>;
  close: () => Promise<void>;
};

export type Holds = {
  annotate: (holdId: string, title: string) => Promise<void>;
};

export type BookingResult =
  | { status: "booked"; summary: string; hold_block_id: string | null }
  | { status: "needs_user"; question: string; hold_block_id: string | null; page_url: string | null }
  | { status: "failed"; reason: string; hold_block_id: string | null; deep_link: string };

export function finalHoldTitle(intent: BookingIntent, outcome: "booked" | "failed"): string {
  const base = buildHoldTitle(intent).replace(" (booking…)", "");
  return outcome === "booked" ? `${base} (booked)` : `${base} (booking failed — finish by hand)`;
}

export async function runBookingLoop(opts: {
  driver: LoopDriver;
  model: ModelCall;
  intent: BookingIntent;
  startUrl: string;
  holdBlockId?: string | null;
  holds?: Holds;
  maxSteps?: number;
  deadlineMs?: number;
  onStep?: (e: { step: number; action: AgentAction; url: string }) => void;
}): Promise<BookingResult> {
  const {
    driver,
    model,
    intent,
    startUrl,
    holdBlockId = null,
    holds,
    maxSteps = 10,
    deadlineMs = 120_000,
    onStep,
  } = opts;
  const fail = async (reason: string): Promise<BookingResult> => {
    if (holds && holdBlockId) await holds.annotate(holdBlockId, finalHoldTitle(intent, "failed")).catch(() => {});
    return { status: "failed", reason, hold_block_id: holdBlockId, deep_link: startUrl };
  };
  const start = Date.now();
  let snap: PageSnapshot;
  try {
    await driver.open();
    snap = await driver.navigate(startUrl);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  for (let step = 0; step < maxSteps; step += 1) {
    if (Date.now() - start > deadlineMs) {
      return fail("Booking took too long — the page is still open for you to finish by hand.");
    }
    let action: AgentAction;
    try {
      action = await nextAgentAction(model, snap, intent);
    } catch (e) {
      return fail(`Brain call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    onStep?.({ step: step + 1, action, url: snap.url });
    try {
      switch (action.kind) {
        case "navigate":
          snap = await driver.navigate(action.url);
          break;
        case "click":
          snap = await driver.click(action.selector);
          break;
        case "type":
          // The agent never handles passwords: a login wall stops the run and
          // hands the visible window to the user instead of failing silently.
          if (/passw/i.test(action.selector)) {
            return {
              status: "needs_user",
              question: "This page wants a login — sign in in the agent window, then tell me to continue.",
              hold_block_id: holdBlockId,
              page_url: snap.url,
            };
          }
          snap = await driver.type(action.selector, action.text);
          break;
        case "snapshot":
          snap = await driver.snapshot();
          break;
        case "ask_user":
          return { status: "needs_user", question: action.question, hold_block_id: holdBlockId, page_url: snap.url };
        case "done":
          if (holds && holdBlockId) await holds.annotate(holdBlockId, finalHoldTitle(intent, "booked")).catch(() => {});
          return { status: "booked", summary: action.summary, hold_block_id: holdBlockId };
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  return fail("Still going after 10 steps — the page is still open for you to finish by hand.");
}
