import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  buildHoldTitle,
  finalHoldTitle,
  formatPlan,
  isContinue,
  isExplicitNo,
  isExplicitYes,
  isStop,
  missingSlots,
  nextQuestion,
  normalizeSiteUrl,
  requiredSlots,
  startUrlFor,
  toAgentTask,
  type BookingDraft,
} from "./bookingTask";

const CONTACT = { firstName: "Alex", lastName: "Kim", phone: "555-0100", email: "alex@example.com" };
const RESTAURANT: BookingDraft = {
  ...EMPTY_DRAFT,
  ...CONTACT,
  type: "restaurant",
  venue: "Nobu",
  area: "Bandra West, Mumbai",
  date: "2026-10-16",
  startTime: "19:30",
  partySize: 2,
  occasion: "none",
};
const BARBER: BookingDraft = { ...EMPTY_DRAFT, ...CONTACT, type: "appointment", venue: "Fade Co", area: "Pune", date: "2026-10-17", startTime: "15:00", service: "haircut" };
const TICKETS: BookingDraft = {
  ...EMPTY_DRAFT,
  ...CONTACT,
  type: "tickets",
  venue: "NSCI Dome",
  area: "Mumbai",
  date: "2026-11-02",
  startTime: "20:00",
  event: "Prateek Kuhad",
  quantity: 2,
  seats: "any",
  maxPrice: "₹3000",
};

describe("slots per task type", () => {
  it("each type has the common slots plus its own, in ask order", () => {
    expect(requiredSlots("restaurant")).toEqual(["venue", "area", "date", "time", "partySize", "first_name", "last_name", "phone", "email", "occasion"]);
    expect(requiredSlots("appointment")).toEqual(["venue", "area", "date", "time", "service", "first_name", "last_name", "phone", "email"]);
    expect(requiredSlots("tickets")).toEqual(["venue", "area", "date", "time", "event", "quantity", "seats", "maxPrice", "first_name", "last_name", "phone", "email"]);
  });

  it("complete drafts need nothing", () => {
    expect(missingSlots(RESTAURANT)).toEqual([]);
    expect(missingSlots(BARBER)).toEqual([]);
    expect(missingSlots(TICKETS)).toEqual([]);
  });

  it("asks exactly one question, for the first missing slot only", () => {
    const d = { ...BARBER, service: null, phone: null, email: null };
    expect(missingSlots(d)).toEqual(["service", "phone", "email"]);
    expect(nextQuestion(d)).toEqual({ slot: "service", question: "Which service do you want?" });
    expect(nextQuestion({ ...TICKETS, quantity: null })?.question).toBe("How many tickets?");
    expect(nextQuestion({ ...RESTAURANT, partySize: null })?.question).toBe("How many people?");
    expect(nextQuestion({ ...RESTAURANT, occasion: null })?.question).toMatch(/occasion/);
    expect(nextQuestion(RESTAURANT)).toBe(null);
  });

  it("never asks cold for what the profile knows: it offers it", () => {
    const known = { displayName: "Alex Kim", email: "alex@acct.com", phone: "555-0199", city: "Pune" };
    expect(nextQuestion({ ...BARBER, area: null }, known)?.question).toBe("In Pune?");
    expect(nextQuestion({ ...BARBER, firstName: null, lastName: null }, known)).toMatchObject({ question: "Should I book it under Alex Kim?", suggestion: "Alex Kim" });
    expect(nextQuestion({ ...BARBER, email: null }, known)?.question).toBe("Use alex@acct.com for the booking email?");
    expect(nextQuestion({ ...BARBER, phone: null }, known)?.question).toBe("Use 555-0199 for the phone number?");
    // No remembered phone: asked plainly.
    expect(nextQuestion({ ...BARBER, phone: null }, { ...known, phone: null })?.question).toBe("What phone number should I put down?");
  });
});

describe("plan read-back (confirmation #1)", () => {
  it("reads every detail back", () => {
    const plan = formatPlan(BARBER);
    expect(plan).toMatch(/^Haircut at Fade Co in Pune, Saturday 3pm, name Alex Kim, phone 555-0100, email alex@example.com\./);
    expect(plan).toMatch(/Say yes or tap Confirm/);
    expect(formatPlan(RESTAURANT)).toMatch(/Table at Nobu in Bandra West, Mumbai, Friday 7:30pm, for 2, name Alex Kim/);
    expect(formatPlan(RESTAURANT)).not.toMatch(/occasion/);
  });

  it("tickets say up front that the user pays", () => {
    expect(formatPlan(TICKETS)).toMatch(/2 tickets for Prateek Kuhad .*up to ₹3000 each.*I'll stop at the payment page/);
  });
});

describe("calendar hold titles", () => {
  it("in flight, booked with reference, failed, unclear", () => {
    const hold = buildHoldTitle(BARBER);
    expect(hold).toBe("Haircut — Fade Co (booking…)");
    expect(finalHoldTitle(hold, "booked", "FC-123")).toBe("Haircut — Fade Co (booked · FC-123)");
    expect(finalHoldTitle(hold, "failed")).toBe("Haircut — Fade Co (booking failed - finish by hand)");
    expect(finalHoldTitle(hold, "unclear")).toBe("Haircut — Fade Co (check booking — not confirmed)");
    expect(buildHoldTitle(RESTAURANT)).toBe("Nobu — 2 (booking…)");
  });
});

describe("where the agent starts", () => {
  it("named site first, else a search", () => {
    expect(startUrlFor({ ...BARBER, siteUrl: "https://fadeco.com/book" })).toBe("https://fadeco.com/book");
    expect(startUrlFor(BARBER)).toBe("https://www.google.com/search?q=Fade%20Co%20Pune%20book");
    expect(startUrlFor(TICKETS)).toBe("https://www.google.com/search?q=Prateek%20Kuhad%20Mumbai%20tickets");
    expect(normalizeSiteUrl("fadeco.com")).toBe("https://fadeco.com");
    expect(normalizeSiteUrl("javascript:alert(1)")).toBe(null);
    expect(normalizeSiteUrl("the usual place")).toBe(null);
  });
});

describe("agent task", () => {
  it("carries the per-type details and drops a 'none' occasion", () => {
    const t = toAgentTask(RESTAURANT, "hold-1", "gpt-5.4");
    expect(t).toMatchObject({ type: "restaurant", venue: "Nobu", time: "19:30", holdBlockId: "hold-1", model: "gpt-5.4", details: { partySize: "2" } });
    expect(toAgentTask(TICKETS, null, "gpt-5.4-mini").details).toEqual({ event: "Prateek Kuhad", quantity: "2", seats: "any", maxPrice: "₹3000" });
    expect(toAgentTask({ ...BARBER, staff: "Sam" }, null).details).toEqual({ service: "haircut", staff: "Sam" });
    expect(toAgentTask({ ...BARBER, endTime: "18:00" }, null).time).toBe("15:00 (window until 18:00)");
  });
});

describe("control words the code checks", () => {
  it("yes / no / stop / continue", () => {
    for (const y of ["yes", "Yes.", "yeah", "ok", "go ahead", "book it", "sure thanks"]) expect(isExplicitYes(y)).toBe(true);
    for (const n of ["maybe", "yes but at 8", "what time is it", ""]) expect(isExplicitYes(n)).toBe(false);
    expect(isExplicitNo("no")).toBe(true);
    expect(isExplicitNo("nope, cancel")).toBe(true);
    expect(isStop("stop")).toBe(true);
    expect(isStop("stop the music and book at 8")).toBe(false);
    expect(isContinue("continue")).toBe(true);
    expect(isContinue("I'm done")).toBe(true);
  });
});
