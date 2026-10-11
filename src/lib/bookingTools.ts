/**
 * Planner tools for Booking Agent v2: find_place → propose_booking →
 * book_appointment, plus answer_agent_question / continue_agent for the
 * pause/resume handoff.
 *
 * Gates enforced here in code, not left to the planner model:
 *   - one question at a time, never for a known fact (bookingTask.ts);
 *   - book_appointment only starts on an explicit yes in the user's own words
 *     this turn (confirmation #1, the plan read-back);
 *   - answers go to the agent as the user's verbatim words, not the planner's
 *     paraphrase;
 *   - the planner can never approve the final click (confirmation #2): that
 *     yes goes straight from the user to the agent (useAssistant fast path or
 *     the Confirm button);
 *   - no tool here ever returns status "booked": success comes only from the
 *     agent's own result with evidence, and is announced by agentClient.ts.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ScheduledBlockRow } from "../../shared/db";
import {
  EMPTY_DRAFT,
  HOLD_MARK,
  TASK_TYPES,
  buildHoldTitle,
  formatPlan,
  isExplicitYes,
  knownFacts,
  missingSlots,
  nextQuestion,
  normalizeSiteUrl,
  rememberFacts,
  splitName,
  startUrlFor,
  toAgentTask,
  type BookingDraft,
  type SlotKey,
  type TaskType,
} from "./bookingTask";
import { agentAvailable, answerAgent, continueAgent, getAgentView, prepareAgent, startAgent } from "./agentClient";

export const BOOKING_TOOL_NAMES = ["find_place", "propose_booking", "book_appointment", "answer_agent_question", "continue_agent"] as const;

const str = { type: "string" } as const;
const int = { type: "integer" } as const;

export const BOOKING_TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "find_place",
      description:
        "Look up where to book: a restaurant, a barber/salon/clinic/any appointment, or an event's tickets. Read-only: confirms the place + area and returns the page the agent will start from. If the area is missing and none is remembered, it tells you to ask for the city — never guess it.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: TASK_TYPES },
          venue: { ...str, description: "Business / venue / event name" },
          area: { ...str, description: "City or neighbourhood" },
          site_url: { ...str, description: "A booking site the user named, if any" },
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
        "Build the booking one detail at a time. Pass every detail the user has given so far, using their exact words. Missing details come back as ONE question to ask. When complete it checks the calendar (fixed commitments win), holds the slot, and returns the full plan to read back verbatim. It never books.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: TASK_TYPES, description: "restaurant, appointment (barber, salon, doctor, any service) or tickets" },
          venue: str,
          area: { ...str, description: "City or neighbourhood" },
          site_url: { ...str, description: "Booking site the user named, if any" },
          date: { ...str, description: "YYYY-MM-DD" },
          start_time: { ...str, description: "HH:MM 24h" },
          end_time: { ...str, description: "HH:MM. For a window ('between 6 and 9') pass the window end" },
          first_name: str,
          last_name: str,
          phone: str,
          email: str,
          party_size: { ...int, description: "restaurant" },
          occasion: { ...str, description: "restaurant, or 'none'" },
          service: { ...str, description: "appointment: haircut, beard trim, cleaning…" },
          staff: { ...str, description: "appointment: preferred person, if the user named one" },
          duration: { ...str, description: "appointment length, if the user said" },
          event: { ...str, description: "tickets: event name" },
          quantity: { ...int, description: "tickets: how many" },
          seats: { ...str, description: "tickets: seat / section preference, or 'any'" },
          max_price: { ...str, description: "tickets: most they'll pay per ticket" },
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
        "Start the booking agent after the user said yes to the plan propose_booking returned. Without confirmed:true it only returns a preview. With confirmed:true and the hold_block_id it opens the visible agent window and starts; it returns status started, never booked. The agent then asks its own questions and reports the result itself.",
      parameters: {
        type: "object",
        properties: { hold_block_id: str, confirmed: { type: "boolean" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_agent_question",
      description:
        "The booking agent is paused on a question (agent_waiting.question in context) and the user just answered it. Rocky passes the user's own words through verbatim. Don't call it for a yes/no on the final confirmation (that goes straight to the agent).",
      parameters: { type: "object", properties: { answer: { ...str, description: "The user's answer, word for word" } }, required: ["answer"] },
    },
  },
  {
    type: "function",
    function: {
      name: "continue_agent",
      description: "The user finished a step by hand in the agent window (signed in, solved a CAPTCHA, paid) and wants the agent to carry on.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

/** Calendar helpers from plannerTools, injected so this module stays testable. */
export type CalendarHelpers = {
  loadBlocks: (from: string, to: string) => Promise<ScheduledBlockRow[]>;
  insertBlock: (row: { source_type: "event"; source_id: null; title: string; date: string; start_time: string; end_time: string }) => Promise<{ id: string }>;
  updateBlock: (id: string, patch: Partial<ScheduledBlockRow>) => Promise<void>;
  fixedOverlapError: (date: string, start: string, end: string) => Promise<unknown>;
  eventOverlapError: (date: string, start: string, end: string, ignoreId?: string) => Promise<unknown>;
  pastDateError: (date: string, field: string) => unknown;
  addMinutes: (time: string, minutes: number) => string;
};

export type BookingToolContext = { userText?: string };

/** Drafts by hold id, plus the one being built. Memory only: nothing persists. */
const drafts = new Map<string, BookingDraft>();
let building: BookingDraft | null = null;
let pendingSuggestion: { slot: SlotKey; value: string } | null = null;
/** The plan last read back: "yes" on the next turn means this one. */
let lastProposedHold: string | null = null;

export function resetBookingState() {
  drafts.clear();
  building = null;
  pendingSuggestion = null;
  lastProposedHold = null;
}

const text = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s ? s : null;
};
const pos = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

function draftFrom(args: Record<string, unknown>, prior: BookingDraft | null): BookingDraft {
  const type: TaskType = TASK_TYPES.includes(args.type as TaskType) ? (args.type as TaskType) : (prior?.type ?? "restaurant");
  const venue = text(args.venue);
  // A different place is a new booking; the same (or unnamed) place continues the draft.
  const base = prior && (!venue || !prior.venue || venue.toLowerCase() === prior.venue.toLowerCase()) && type === prior.type ? prior : { ...EMPTY_DRAFT, type };
  const pick = <K extends keyof BookingDraft>(k: K, v: BookingDraft[K] | null) => (v != null ? v : base[k]);
  return {
    type,
    venue: pick("venue", venue),
    area: pick("area", text(args.area)),
    date: pick("date", text(args.date)),
    startTime: pick("startTime", text(args.start_time)),
    endTime: pick("endTime", text(args.end_time)),
    firstName: pick("firstName", text(args.first_name)),
    lastName: pick("lastName", text(args.last_name)),
    phone: pick("phone", text(args.phone)),
    email: pick("email", text(args.email)),
    siteUrl: pick("siteUrl", normalizeSiteUrl(text(args.site_url))),
    partySize: pick("partySize", pos(args.party_size)),
    occasion: pick("occasion", text(args.occasion)),
    service: pick("service", text(args.service)),
    staff: pick("staff", text(args.staff)),
    duration: pick("duration", text(args.duration)),
    event: pick("event", text(args.event)),
    quantity: pick("quantity", pos(args.quantity)),
    seats: pick("seats", text(args.seats)),
    maxPrice: pick("maxPrice", text(args.max_price)),
  };
}

/** A "yes" to "Use om@… for the email?" fills that slot in code. */
function applySuggestion(d: BookingDraft, userText: string | undefined): BookingDraft {
  const s = pendingSuggestion;
  pendingSuggestion = null;
  if (!s || !isExplicitYes(userText)) return d;
  const next = { ...d };
  if (s.slot === "email" && !next.email) next.email = s.value;
  if (s.slot === "phone" && !next.phone) next.phone = s.value;
  if (s.slot === "area" && !next.area) next.area = s.value;
  if ((s.slot === "first_name" || s.slot === "last_name") && !next.firstName && !next.lastName) {
    const n = splitName(s.value);
    if (n) {
      next.firstName = n.first;
      next.lastName = n.last;
    }
  }
  return next;
}

const DURATION_MIN: Record<TaskType, number> = { restaurant: 90, appointment: 60, tickets: 150 };

export async function runBookingTool(name: string, args: Record<string, unknown>, ctx: BookingToolContext, cal: CalendarHelpers): Promise<unknown> {
  switch (name) {
    case "find_place": {
      const venue = text(args.venue);
      if (!venue) return { error: "venue is required — ask which place to book." };
      const type: TaskType = TASK_TYPES.includes(args.type as TaskType) ? (args.type as TaskType) : "restaurant";
      let area = text(args.area);
      if (!area) {
        const known = await knownFacts();
        if (known.city) area = known.city;
        else return { needs: ["area"], question: "Which city or neighbourhood?" };
      }
      const siteUrl = normalizeSiteUrl(text(args.site_url));
      return {
        venue,
        area,
        start_url: startUrlFor({ type, venue, area, siteUrl, event: type === "tickets" ? venue : null }),
        hint: "The agent opens the named site, or picks the official booking page from a search. Never invent an address or a site.",
      };
    }

    case "propose_booking": {
      const known = await knownFacts();
      let d = applySuggestion(draftFrom(args, building), ctx.userText);
      building = d;
      const missing = missingSlots(d);
      if (missing.length > 0) {
        const q = nextQuestion(d, known);
        if (q?.suggestion) pendingSuggestion = { slot: q.slot, value: q.suggestion };
        return {
          needs: missing,
          question: q?.question,
          next: "Ask exactly this one question, word for word, then stop. On the next turn call propose_booking again with every detail so far plus the answer.",
        };
      }
      const date = d.date as string;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00`).getTime())) {
        return { error: "date must be a real YYYY-MM-DD date." };
      }
      const start = d.startTime as string;
      if (!/^\d{1,2}:\d{2}$/.test(start)) return { error: "start_time must be HH:MM." };
      const end = d.endTime && /^\d{1,2}:\d{2}$/.test(d.endTime) ? d.endTime : cal.addMinutes(start, DURATION_MIN[d.type]);
      const past = cal.pastDateError(date, "date");
      if (past) return past;
      // A booking is an ordinary event: fixed commitments always win.
      const fixedClash = await cal.fixedOverlapError(date, start, end);
      if (fixedClash) return fixedClash;
      // Re-proposing moves the existing hold instead of stacking a second one.
      const dayBlocks = await cal.loadBlocks(date, date);
      const prevHold = [...drafts.entries()].find(([, v]) => v.venue?.toLowerCase() === d.venue?.toLowerCase())?.[0];
      // A retry after a failed or unclear run reuses that hold too (it survives
      // an app restart, the in-memory draft doesn't), instead of clashing with it.
      const isOurHold = (t: string) => t.includes(HOLD_MARK) || /\((booking failed|check booking)/.test(t);
      const ownHold = dayBlocks.find((b) => b.id === prevHold) ?? dayBlocks.find((b) => isOurHold(b.title) && d.venue && b.title.toLowerCase().includes(d.venue.toLowerCase()));
      const eventClash = await cal.eventOverlapError(date, start, end, ownHold?.id);
      if (eventClash) return eventClash;
      d = { ...d, endTime: d.endTime ?? null };
      await rememberFacts({ phone: d.phone, city: d.area });
      const title = buildHoldTitle(d);
      let holdId: string;
      if (ownHold) {
        await cal.updateBlock(ownHold.id, { title, date, start_time: start, end_time: end });
        holdId = ownHold.id;
      } else {
        holdId = (await cal.insertBlock({ source_type: "event", source_id: null, title, date, start_time: start, end_time: end })).id;
      }
      for (const [k, v] of drafts) if (k !== holdId && v.venue === d.venue) drafts.delete(k);
      drafts.set(holdId, d);
      building = d;
      lastProposedHold = holdId;
      // Load the booking page while the plan is read back; the run itself
      // still waits for the yes (book_appointment).
      if (agentAvailable()) prepareAgent(toAgentTask(d, holdId));
      return {
        proposed: true,
        summary: formatPlan(d),
        hold_block_id: holdId,
        next: "Read summary to the user word for word, then stop and wait. Only after an explicit yes, call book_appointment with confirmed:true and this hold_block_id.",
      };
    }

    case "book_appointment": {
      // Past turns reach the planner as text only, so the hold id from the
      // read-back is often missing on the "yes" turn: fall back to that plan.
      const asked = text(args.hold_block_id);
      const holdId = asked && drafts.has(asked) ? asked : lastProposedHold;
      const d = (holdId && drafts.get(holdId)) || null;
      if (!d || !holdId) return { error: "No proposed booking with that hold_block_id. Call propose_booking first and read the plan back." };
      if (args.confirmed !== true) {
        return { needs_confirmation: true, preview: `${formatPlan(d)}` };
      }
      // Confirmation #1, checked against the user's own words, not the model's.
      if (!isExplicitYes(ctx.userText)) {
        return { error: "The user hasn't said yes to the plan this turn. Read the plan back and wait for an explicit yes. Do not start the booking." };
      }
      if (!agentAvailable()) {
        return {
          status: "needs_desktop",
          hold_block_id: holdId,
          deep_link: startUrlFor(d),
          instruction: "No agent here (the laptop app isn't connected). Give the user the link to finish by hand; the hold stays on their calendar. Never say it's booked.",
        };
      }
      const started = await startAgent(toAgentTask(d, holdId));
      if (!started.ok) return { status: "not_started", reason: started.error, hold_block_id: holdId };
      return {
        status: "started",
        hold_block_id: holdId,
        say: "One short line, e.g. \"On it — watch the agent window. I'll ask if I need anything.\" Never say booked: the agent reports the result itself.",
      };
    }

    case "answer_agent_question": {
      const v = getAgentView();
      if (v.phase !== "question") return { error: "The agent isn't waiting on a question right now." };
      // The user's own words, verbatim — never the planner's rewrite.
      const answer = (ctx.userText ?? "").trim() || String(args.answer ?? "").trim();
      if (!answer) return { error: "Empty answer." };
      const ok = await answerAgent(answer);
      return ok ? { status: "answered", say: "Just 'Got it.' The agent continues on its own." } : { error: "The agent didn't take the answer." };
    }

    case "continue_agent": {
      const ok = await continueAgent();
      return ok ? { status: "continuing", say: "Just 'Carrying on.'" } : { error: "The agent isn't waiting on you right now." };
    }

    default:
      throw new Error(`Unknown booking tool: ${name}`);
  }
}

/** What the planner should know about a paused run, injected into its context. */
export function agentWaitingContext(): string | null {
  const v = getAgentView();
  if (v.phase === "question") {
    return `The booking agent is paused, waiting for the user's answer to: "${v.question}". If the user's message answers it, call answer_agent_question (Rocky forwards their exact words). Never answer it yourself, never rephrase it.`;
  }
  if (v.phase === "takeover") {
    return `The booking agent is waiting for the user to finish a step in the agent window: "${v.message}". If they say they're done, call continue_agent.`;
  }
  if (["starting", "running", "confirm"].includes(v.phase)) {
    return "A booking agent run is in progress. Don't start another, and never say it's booked: the agent reports the result itself.";
  }
  return null;
}
