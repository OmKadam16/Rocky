import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledBlockRow } from "../../shared/db";

// Remembered facts live in a fake profile; the agent is stubbed.
const profile = vi.hoisted(() => ({ facts: {} as Record<string, string> }));
vi.mock("./bookingTask", async (orig) => {
  const real = await orig<typeof import("./bookingTask")>();
  return {
    ...real,
    knownFacts: async () => ({
      phone: profile.facts.booking_phone ?? null,
      city: profile.facts.home_city ?? null,
      bookingFirstName: profile.facts.booking_first_name ?? null,
      bookingLastName: profile.facts.booking_last_name ?? null,
      bookingEmail: profile.facts.booking_email ?? null,
      email: "om4kadam@gmail.com",
    }),
    rememberFacts: async (f: { phone?: string | null; city?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null }) => {
      if (f.phone) profile.facts.booking_phone = f.phone;
      if (f.city) profile.facts.home_city = f.city;
      if (f.firstName && f.lastName) {
        profile.facts.booking_first_name = f.firstName;
        profile.facts.booking_last_name = f.lastName;
      }
      if (f.email) profile.facts.booking_email = f.email;
    },
  };
});
vi.mock("./agentClient", () => ({
  agentAvailable: () => true,
  getAgentView: () => ({ phase: "idle" }),
  isAgentActive: () => false,
  startAgent: async () => ({ ok: true }),
  answerAgent: async () => true,
  continueAgent: async () => true,
  prepareAgent: () => {},
}));

import { resetBookingState, runBookingTool, samePlace, type CalendarHelpers } from "./bookingTools";

function calendar() {
  const blocks: ScheduledBlockRow[] = [];
  const cal: CalendarHelpers = {
    loadBlocks: async (from) => blocks.filter((b) => b.date === from),
    insertBlock: async (row) => {
      const b = { ...row, id: `b${blocks.length + 1}`, previous_start_time: null, created_at: "" } as ScheduledBlockRow;
      blocks.push(b);
      return { id: b.id };
    },
    updateBlock: async () => {},
    fixedOverlapError: async () => null,
    eventOverlapError: async () => null,
    pastDateError: () => null,
    addMinutes: (t, m) => {
      const [h, mm] = t.split(":").map(Number);
      const total = h * 60 + mm + m;
      return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    },
  };
  return { cal, blocks };
}

const propose = (args: Record<string, unknown>, userText: string, cal: CalendarHelpers) =>
  runBookingTool("propose_booking", args, { userText }, cal) as Promise<Record<string, unknown>>;

beforeEach(() => {
  resetBookingState();
  profile.facts = {};
});

describe("the Nobu transcript: nothing the user said is lost or asked twice", () => {
  it("a type correction (appointment -> restaurant) and a longer venue name keep the draft", async () => {
    const { cal } = calendar();
    // Turn 1: the user said "appointment"; the planner sent type appointment.
    await propose({ type: "appointment", venue: "Nobu", area: "Newport", date: "2099-10-13", start_time: "19:00" }, "book me an appointment at Nobu", cal);
    await propose({ party_size: 3 }, "3", cal);
    await propose({ first_name: "Om" }, "Om", cal);
    // The planner corrects the type and names the place more fully, passing only some details.
    const r = await propose({ type: "restaurant", venue: "Nobu Newport Beach", last_name: "Kadam" }, "Kadam", cal);
    const asked = String(r.question ?? "");
    expect(asked).not.toMatch(/venue|restaurant and city|date|start time|how many|first name|last name|service/i);
    expect(r.needs).not.toContain("venue");
    expect(r.needs).not.toContain("partySize");
    expect(r.needs).not.toContain("first_name");
    expect(r.needs).not.toContain("service");
  });

  it("asked once, never again: the next booking reuses name, phone and email without a question", async () => {
    const { cal } = calendar();
    await propose({ type: "restaurant", venue: "Nobu", area: "Newport", date: "2099-10-13", start_time: "19:00", party_size: 3 }, "", cal);
    await propose({ first_name: "Om", last_name: "Kadam", phone: "5628506835" }, "", cal);
    const emailQ = await propose({}, "", cal);
    expect(emailQ.question).toBe("Use om4kadam@gmail.com for the booking email?");
    await propose({}, "yes", cal); // confirms the suggestion
    expect(profile.facts).toMatchObject({ booking_first_name: "Om", booking_last_name: "Kadam", booking_phone: "5628506835", booking_email: "om4kadam@gmail.com" });

    // A new booking somewhere else: no contact questions at all.
    resetBookingState();
    const next = await propose({ type: "restaurant", venue: "Din Tai Fung", area: "Costa Mesa", date: "2099-10-20", start_time: "18:30", party_size: 2, occasion: "none" }, "", cal);
    expect(next.proposed).toBe(true);
    expect(String(next.summary)).toMatch(/Om Kadam/);
    expect(String(next.summary)).toMatch(/5628506835/);
    expect(String(next.summary)).toMatch(/om4kadam@gmail.com/);
  });

  it("a different place starts a fresh booking but keeps who's booking", async () => {
    const { cal } = calendar();
    await propose({ type: "restaurant", venue: "Nobu", area: "Newport", date: "2099-10-13", start_time: "19:00", first_name: "Om", last_name: "Kadam" }, "", cal);
    const r = await propose({ type: "restaurant", venue: "Din Tai Fung" }, "", cal);
    expect(r.needs).toContain("area");
    expect(r.needs).toContain("date");
    expect(r.needs).not.toContain("first_name");
  });

  it("place names match loosely", () => {
    expect(samePlace("Nobu", "Nobu Newport Beach")).toBe(true);
    expect(samePlace("nobu newport", "Nobu")).toBe(true);
    expect(samePlace("Nobu", "Din Tai Fung")).toBe(false);
  });
});
