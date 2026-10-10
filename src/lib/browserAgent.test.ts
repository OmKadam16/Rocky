import { describe, expect, it } from "vitest";
import {
  buildBookingSearchUrl,
  buildHoldTitle,
  formatProposal,
  isBookingComplete,
  missingBookingSlots,
  nextAgentAction,
  nextBookingQuestion,
  parseAgentAction,
  type BookingIntent,
} from "./browserAgent";

const FULL: BookingIntent = {
  venue: "Nobu",
  area: "Bandra West, Mumbai",
  date: "2026-10-16",
  startTime: "19:30",
  endTime: "21:00",
  partySize: 2,
};

describe("booking slot-filling", () => {
  it("asks slots in order: venue, area, date, time, party", () => {
    expect(nextBookingQuestion({ ...FULL, venue: null })).toBe("Which place should I book?");
    expect(nextBookingQuestion({ ...FULL, area: null })).toBe("Which city or neighbourhood?");
    expect(nextBookingQuestion({ ...FULL, date: null })).toBe("Which day?");
    expect(nextBookingQuestion({ ...FULL, startTime: null })).toBe("What time?");
    expect(nextBookingQuestion({ ...FULL, partySize: null })).toBe("How many people?");
    expect(nextBookingQuestion(FULL)).toBeNull();
    expect(isBookingComplete(FULL)).toBe(true);
  });

  it("treats blank strings and zero party as missing", () => {
    expect(missingBookingSlots({ ...FULL, venue: "  ", partySize: 0 })).toEqual(["venue", "partySize"]);
  });
});

describe("proposal copy", () => {
  it("reads like a person, never 24h times", () => {
    expect(formatProposal(FULL)).toBe("Nobu Friday at 7:30pm for 2 — say yes or tap Confirm and I'll book it.");
    expect(buildHoldTitle(FULL)).toBe("Nobu — 2, Fri 7:30pm (booking…)");
  });

  it("builds an encoded search fallback link", () => {
    expect(buildBookingSearchUrl(FULL)).toBe(
      "https://www.google.com/search?q=" + encodeURIComponent("Nobu Bandra West, Mumbai book a table"),
    );
  });
});

describe("agent action parsing", () => {
  it("accepts well-formed actions", () => {
    expect(parseAgentAction('{"kind":"click","selector":"#book"}')).toEqual({ kind: "click", selector: "#book" });
    expect(parseAgentAction('noise {"kind":"done","summary":"Booked!"} trailing')).toEqual({ kind: "done", summary: "Booked!" });
  });

  it("rejects unsafe navigations and garbage as ask_user, never acts", () => {
    expect(parseAgentAction('{"kind":"navigate","url":"file:///etc/passwd"}').kind).toBe("ask_user");
    expect(parseAgentAction("totally not json").kind).toBe("ask_user");
    expect(parseAgentAction('{"kind":"click"}').kind).toBe("ask_user");
  });

  it("runs one worker step through an injected model call", async () => {
    const action = await nextAgentAction(
      async () => '{"kind":"type","selector":"#party","text":"2"}',
      { url: "https://example.com", title: "Book", text: "party size" },
      FULL,
    );
    expect(action).toEqual({ kind: "type", selector: "#party", text: "2" });
  });
});
