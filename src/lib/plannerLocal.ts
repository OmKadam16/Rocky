import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { db } from "./db";
import { PROVIDER_BASE_URL, normalizeProvider, resolveModelId } from "./models";
import { getSecret } from "./secrets";
import { SYSTEM_PROMPT } from "./plannerPrompt";
import { MUTATING_TOOLS, contextSnapshot, runTool, toolSchemas } from "./plannerTools";
import { loadMemory, memoryContext } from "./chatMemory";
import { BOOKING_TOOL_NAMES, agentWaitingContext } from "./bookingTools";
import { COMMITMENT_TOOL_NAMES } from "./commitmentTools";
import { isAgentActive } from "./agentClient";
import { describeFree, detectUrgency, enforceExplicitTime, explicitWindow, isProvablyFree, parseRequestedWindow } from "./availability";
import type { AssistantTurn } from "../types";

/** The last few turns the cloud planner may see: never private ones. */
export function plannerHistory(history: AssistantTurn[], max = 8): AssistantTurn[] {
  return history.filter((t) => !t.private).slice(-max);
}

const MAX_TOOL_ROUNDS = 8;

/**
 * Phrases that assert the calendar changed.
 *
 * Deliberately broad. A false positive costs one extra round trip; a false
 * negative tells the user their lunch is booked when it is not. The model
 * will occasionally narrate an action instead of taking it — this is the
 * backstop that stops that reaching the user.
 */
/**
 * Refusing on grounds it never checked.
 *
 * Three times now the model has declined a perfectly bookable request —
 * "that conflicts with your fixed commitments" for 7pm on an evening with
 * nothing in it, having just offered that same slot itself. A refusal is only
 * credible if a tool produced it, so an unverified one goes back with
 * tool_choice forced.
 */
const REFUSES_WITHOUT_CHECKING =
  /\b(?:can'?t|cannot|unable to|won'?t be able)\b[^.!?]*\b(?:move|change|reschedule|add|book|fit|schedule)\b|\bconflicts?\b|\bclash(?:es|ing)?\b|\boverlaps?\b|\bfixed commitments? can'?t be\b|\bthat (?:won'?t|doesn'?t) work\b|\bnot free\b|\bnothing (?:free|open|available)\b/i;

/**
 * The reassuring form of the same words — "no conflict", "that doesn't clash".
 * Without this the broadened detector above would send a perfectly good
 * confirmation back for a needless second round.
 */
const NO_CONFLICT =
  /\b(?:no|without(?: any)?|any|doesn'?t|don'?t|isn'?t a|not a)\s+(?:\w+\s+){0,2}(?:conflicts?|clash(?:es)?|overlaps?)\b/i;

/**
 * Promising rather than doing. "I'll schedule the dinner for 19:50. Let me do
 * that now." — and then the turn ends and nothing has happened. Not a lie
 * exactly, which is why the past-tense detector below misses it, but the user
 * is left waiting for something that will never arrive.
 */
const PROMISES_A_CHANGE =
  /\b(?:i'?ll|i will|let me|i'?m going to|going to|about to)\b[^.!?]*\b(?:schedule|add|book|move|put|set|slot|place|shift|reschedule)\b/i;

const CLAIMS_A_CHANGE =
  /\b(?:done|booked|added|scheduled|rescheduled|moved|shifted|created|deleted|removed|cancell?ed|slotted|locked in|all set|sorted|you'?re on for|put (?:it|that|you|lunch|dinner|them))\b|\bon (?:your|the) calendar\b/i;

/**
 * Claiming an external booking is done. A calendar hold (propose_booking) is
 * a pencil mark, not a reservation — only book_appointment returning status
 * "booked" earns booked-language. This is the backstop that stops "Done —
 * Nobu's booked" reaching the user when nothing was booked.
 */
const CLAIMS_BOOKED =
  /\b(?:booked|reserved|confirmed|reservation(?: is)? (?:confirmed|complete|done|made)|locked in|you'?re (?:booked|on for)|table(?: is)? (?:booked|reserved)|confirmation (?:number|ref|code|email))\b/i;

export type PlannerTiming = {
  /** Supabase reads for the turn context. */
  snapshotMs: number;
  /** All model round-trips put together. */
  llmMs: number;
  /** Tool execution (each hits the database). */
  toolMs: number;
  /** How many model round-trips the turn took. */
  rounds: number;
  /** Wall clock for the whole planner call. */
  totalMs: number;
};

export type PlannerResult = {
  reply: string;
  tools_used: { name: string; arguments: unknown; result: unknown }[];
  schedule_changed: boolean;
  timing: PlannerTiming;
};

/**
 * The planner loop, in the browser: context in, tool calls executed against the
 * local database, natural-language reply out.
 */
/** The planner's own client (provider, key, model), for small side calls. */
async function plannerClient(): Promise<{ openai: OpenAI; model: string } | null> {
  const profile = await db.profiles.get("local");
  const key = (await getSecret("llm_key"))?.trim();
  if (!key || (typeof navigator !== "undefined" && !navigator.onLine)) return null;
  const provider = normalizeProvider((profile as unknown as { provider?: string | null })?.provider);
  const openai = new OpenAI({
    apiKey: key,
    baseURL: PROVIDER_BASE_URL[provider] ?? PROVIDER_BASE_URL.OpenAI,
    dangerouslyAllowBrowser: true,
    defaultHeaders: provider === "Anthropic" ? { "anthropic-dangerous-direct-browser-access": "true" } : undefined,
  });
  return { openai, model: resolveModelId(profile?.model, provider) };
}

/** One plain completion on the planner's key (chat memory summary). Null on any failure. */
export async function completeWithPlanner(p: { system: string; user: string }): Promise<string | null> {
  try {
    const c = await plannerClient();
    if (!c) return null;
    const r = await c.openai.chat.completions.create({
      model: c.model,
      messages: [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
    });
    return r.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export async function askPlannerLocal(
  message: string,
  history: AssistantTurn[],
): Promise<PlannerResult> {
  const t0 = Date.now();
  let snapshotMs = 0;
  let llmMs = 0;
  let toolMs = 0;
  let rounds = 0;
  const stamp = (): PlannerTiming => ({ snapshotMs, llmMs, toolMs, rounds, totalMs: Date.now() - t0 });
  const profile = await db.profiles.get("local");
  const key = (await getSecret("llm_key"))?.trim();
  if (!key) {
    return {
      reply:
        "Add your API key in Profile → Model to enable AI planning. You're in local mode — calendar still works by hand.",
      tools_used: [],
      schedule_changed: false,
      timing: stamp(),
    };
  }
  if (!navigator.onLine) {
    return {
      reply: "You're offline — AI needs internet. Calendar and manual adds still work.",
      tools_used: [],
      schedule_changed: false,
      timing: stamp(),
    };
  }

  const provider = normalizeProvider((profile as unknown as { provider?: string | null })?.provider);
  const openai = new OpenAI({
    apiKey: key,
    baseURL: PROVIDER_BASE_URL[provider] ?? PROVIDER_BASE_URL.OpenAI,
    dangerouslyAllowBrowser: true,
    defaultHeaders: provider === "Anthropic" ? { "anthropic-dangerous-direct-browser-access": "true" } : undefined,
  });
  // The profile may hold a display label from an older build; the API needs an id.
  const model = resolveModelId(profile?.model, provider);
  const toolsUsed: PlannerResult["tools_used"] = [];

  try {
    const tSnap = Date.now();
    const snapshot: any = await contextSnapshot();
    snapshotMs += Date.now() - tSnap;
    // Preferences ride the snapshot — no second database round-trip.
    const prefs = ((snapshot.prefs as Record<string, unknown> | undefined) ?? null) as Record<string, unknown> | null;
    const aboutText = String(profile?.about_text ?? "").trim().slice(0, 2000);
    const earliest = String((prefs?.earliest_start_time as string | undefined) ?? "?");
    const latest = String((prefs?.latest_end_time as string | undefined) ?? "?");
    const study = Array.isArray(prefs?.preferred_study_hours) ? (prefs?.preferred_study_hours as { start: string; end: string }[]) : [];
    const prefText = prefs ? `Preferences: earliest ${earliest} to latest ${latest}${study.length ? `; preferred study ${study.map((h) => `${h.start}-${h.end}`).join(", ")}` : ""}.` : "";
    const about = aboutText ? `\n\nWhat the user told you about themselves: ${aboutText}${prefText ? `\n${prefText}` : ""}` : prefText ? `\n\n${prefText}` : "";

    // Chat memory first: what the user asked Rocky to keep, and a summary of
    // conversation that has left the window below (or was cleared).
    const memory = memoryContext(await loadMemory());
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT + about },
      ...(memory ? [{ role: "system", content: memory } as ChatCompletionMessageParam] : []),
      {
        role: "system",
        content: `Current context (JSON). Today is ${snapshot.today} (${snapshot.today_weekday}), the time is ${snapshot.now}. ` +
            (snapshot.today_schedule.is_completely_free
              ? "Today is completely free — nothing is on it, so nothing can clash with it."
              : `Today holds exactly: ${[
                  ...(snapshot.today_schedule.fixed_commitments as any[]).map((c: any) => `${c.name} ${c.start_time}-${c.end_time}`),
                  ...(snapshot.today_schedule.blocks as any[]).map((b: any) => `${b.title} ${b.start_time}-${b.end_time}`),
                ].join("; ")}. Nothing else is on today.`) +
            `\n${JSON.stringify(snapshot)}`,
      },
      // Private turns (Memory questions/answers, receipts) never reach the cloud planner.
      ...plannerHistory(history).map((turn) => ({ role: turn.role, content: turn.text }) as ChatCompletionMessageParam),
      { role: "user", content: message },
    ];

    /**
     * What the user asked for, checked against the calendar in code.
     *
     * The time often arrives one turn before the day — "8 to 10pm", then
     * "change it to today" — so a message with no time of its own is read
     * together with the previous one. This can only ever prove a window free;
     * an uncertain parse proves nothing and changes nothing.
     */
    const previousUserText = [...history].reverse().find((t) => t.role === "user")?.text ?? "";
    const requested =
      parseRequestedWindow(message, snapshot) ??
        parseRequestedWindow(`${previousUserText} ${message}`, snapshot);
    const provablyFree = requested ? isProvablyFree(requested, snapshot.week?.days ?? []) : false;

    // A time named in this message, strict enough to overrule the model with.
    // Only from the current message: an hour mentioned a turn ago is context,
    // not an instruction about the booking being made now.
    const explicit = explicitWindow(message, snapshot);
    // Urgency carries over one turn: "this is important" often arrives just
    // before the day/time ("change it to today"), so read both together.
    const urgent = detectUrgency(`${message} ${previousUserText}`);
    // A paused booking agent: tell the planner what it is waiting on, so an
    // answer goes to answer_agent_question instead of starting something new.
    const waiting = agentWaitingContext();
    if (waiting) messages.push({ role: "system", content: `agent_waiting: ${waiting}` });
    if (urgent) {
      messages.push({
        role: "system",
        content:
          "The user marked this request urgent or important. Place it first at the requested time (or the earliest fitting slot via find_open_slot), then let conflict resolution move lower-priority blocks around it — that is expected, not a problem. Name everything that moved in your reply. Fixed commitments (immutable:true) still never move.",
      });
    }
    let corrections = 0;

    // One corrective round each: a wrongly-refused turn should not use up the
    // false-success guard's only chance to intervene.
    let nudgedRefusal = false;
    let nudgedClaim = false;
    let nudgedBookingClaim = false;
    let forceTool = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const tLlm = Date.now();
      const completion = await openai.chat.completions.create({
        model,
        messages,
        tools: toolSchemas,
        // A corrective round forces a call: asking the model to go and check
        // was not enough, so it no longer gets to answer from memory.
        tool_choice: forceTool ? "required" : "auto",
      });
      llmMs += Date.now() - tLlm;
      rounds += 1;
      forceTool = false;

      const choice = completion.choices[0].message;
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        const reply = choice.content?.trim() || "Got it.";
        const changed = toolsUsed.some((t) => MUTATING_TOOLS.has(t.name));
        // A commitment card counts as acting (the user confirms it on screen),
        // so the did-nothing guards leave it alone.
        const proposed = toolsUsed.some(
          (t) => (COMMITMENT_TOOL_NAMES as readonly string[]).includes(t.name) && Boolean((t.result as { proposal_id?: unknown } | null)?.proposal_id),
        );
        const acted = changed || proposed;
        // Nothing is saved until Confirm: never let "added" / "saved" reach the user.
        if (proposed && CLAIMS_A_CHANGE.test(reply)) {
          return { reply: "Here it is — tap Confirm or say yes.", tools_used: toolsUsed, schedule_changed: changed, timing: stamp() };
        }

        // Refused without changing anything, so nothing has verified the claim.
        // Read-only calls don't count: it can fetch the week and still get the
        // arithmetic wrong, which is exactly the failure this catches.
        if (
          !acted &&
          !nudgedRefusal &&
          REFUSES_WITHOUT_CHECKING.test(reply) &&
          !NO_CONFLICT.test(reply)
        ) {
          nudgedRefusal = true;
          forceTool = true;
          const span = requested?.end ? `${requested.start}-${requested.end}` : requested?.start;
          messages.push({
            role: "system",
            content:
              "You just told the user something could not be done, but nothing on their calendar changed, so you have not verified anything. " +
              // Proven free by the same code the scheduler runs on. Not an
              // argument for the model to weigh — a fact it is handed.
              (provablyFree && requested
                ? `Computed from their calendar rather than reasoned about: on ${requested.date} they are free ${describeFree(requested.date, snapshot.week?.days ?? [])}, and the ${span} you just refused sits inside that. It is free. Place it. `
                : "") +
              "Every day in week.days carries a free_windows list — and today_schedule.free_windows repeats today's — giving exactly when the user is free. " +
              "A time inside one of those windows is bookable, and a commitment that ends before that time does not clash with it: " +
              "a lab finishing at 17:50 has no bearing on an eight o'clock meeting. Only entries with immutable:true are fixed; anything without that flag can be moved. " +
              "Check it, or call find_open_slot or reschedule_block and let the result decide. If you still refuse, name the exact entry (title and hours on that date) whose hours overlap the requested hours — a refusal without that is not credible. Only a tool result can justify refusing.",
          });
          continue;
        }

        // Refused twice over a window the calendar says is empty. Passing the
        // reply on would tell the user their evening is booked when it is not.
        if (!acted && nudgedRefusal && provablyFree && requested && REFUSES_WITHOUT_CHECKING.test(reply) && !NO_CONFLICT.test(reply)) {
          return {
            reply: `That time's actually clear — there's nothing on ${requested.date === snapshot.today ? "today" : "that day"} then. I couldn't get it placed though, so say it once more.`,
            tools_used: toolsUsed,
            schedule_changed: false,
            timing: stamp(),
          };
        }

        // It said it did something but called nothing. Give it one chance to
        // actually do it, then refuse to pass the claim on.
        if (!acted && (CLAIMS_A_CHANGE.test(reply) || PROMISES_A_CHANGE.test(reply))) {
          if (!nudgedClaim) {
            nudgedClaim = true;
            forceTool = true;
            messages.push({
              role: "system",
              content:
                "You just told the user their calendar changed, or that you were about to change it, but you called no tool, so nothing happened and the turn is over. " +
                "Either call the correct tool now, or reply plainly that you have not made the change and say what you need from them. " +
                "Never describe a change you did not make.",
            });
            continue;
          }
          return {
            reply: "I didn't actually get that onto your calendar — say it once more and I'll take another run at it.",
            tools_used: toolsUsed,
            schedule_changed: false,
            timing: stamp(),
          };
        }

        // Only the agent announces a booking (agentClient.ts, with evidence
        // from the confirmation page). No planner tool returns "booked", so any
        // booked-language here, around a booking, is a fabrication.
        const bookingTouched = isAgentActive() || toolsUsed.some((t) => (BOOKING_TOOL_NAMES as readonly string[]).includes(t.name));
        if (bookingTouched && CLAIMS_BOOKED.test(reply)) {
          if (!nudgedBookingClaim) {
            nudgedBookingClaim = true;
            messages.push({
              role: "system",
              content:
                "You just told the user a booking is done or confirmed. You never announce bookings: a (booking…) hold or a started agent is not a reservation, and the agent reports its own result with the page's reference. " +
                "Reply again without saying booked, confirmed or reserved: say what is actually happening (the agent is working, or what is still missing). " +
                "Never present holds as completed bookings, never invent a confirmation reference, and never list two holds as two bookings.",
            });
            continue;
          }
          return {
            reply: "It isn't booked yet — the time is only held on your calendar. I'll say so the moment the booking page confirms it.",
            tools_used: toolsUsed,
            schedule_changed: changed,
            timing: stamp(),
          };
        }

        return { reply, tools_used: toolsUsed, schedule_changed: changed, timing: stamp() };
      }

      for (const call of calls) {
        if (call.type !== "function") continue;
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};

        // Booking somewhere other than the time the user gave. Send it back
        // rather than run it — a wrong time written to the calendar is worse
        // than a second round trip.
        const correction = explicit && corrections < 2 ? enforceExplicitTime(call.function.name, args, explicit) : null;
        if (correction) {
          corrections += 1;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: correction }) });
          continue;
        }

        let result: unknown;
        const tTool = Date.now();
        try {
          result = await runTool(call.function.name, args, { openai, model, urgent, userText: message });
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        toolMs += Date.now() - tTool;
        toolsUsed.push({ name: call.function.name, arguments: args, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    return {
      reply: "I got tangled up working that out — can you say it again more simply?",
      tools_used: toolsUsed,
      schedule_changed: toolsUsed.some((t) => MUTATING_TOOLS.has(t.name)),
      timing: stamp(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reply: `Local AI error: ${message}`,
      tools_used: toolsUsed,
      schedule_changed: toolsUsed.some((t) => MUTATING_TOOLS.has(t.name)),
      timing: stamp(),
    };
  }
}
