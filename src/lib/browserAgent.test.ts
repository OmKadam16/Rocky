import { describe, expect, it } from "vitest";
import {
  buildBookingSearchUrl,
  buildHoldTitle,
  finalHoldTitle,
  formatProposal,
  isBookingComplete,
  missingBookingSlots,
  nextAgentAction,
  nextBookingQuestion,
  parseAgentAction,
  runBookingLoop,
  type BookingIntent,
  type LoopDriver,
  type PageSnapshot,
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

describe("drive loop", () => {
  const snap = (url: string): PageSnapshot => ({ url, title: "Book", text: "reserve a table" });

  const stubDriver = (seen: string[]): LoopDriver => ({
    open: async () => { seen.push("open"); },
    navigate: async (url: string) => { seen.push(`go:${url}`); return snap(url); },
    snapshot: async () => { seen.push("snap"); return snap("https://example.com/book"); },
    click: async (selector: string) => { seen.push(`click:${selector}`); return snap("https://example.com/book"); },
    type: async (selector: string, text: string) => { seen.push(`type:${selector}=${text}`); return snap("https://example.com/book"); },
    close: async () => { seen.push("close"); },
  });

  it("books: acts, annotates the hold, leaves the window open", async () => {
    const seen: string[] = [];
    const annotated: [string, string][] = [];
    const replies = ['{"kind":"click","selector":"#reserve"}', '{"kind":"done","summary":"Booked Nobu Fri 7:30pm for 2, ref X1"}'];
    const result = await runBookingLoop({
      driver: stubDriver(seen),
      model: async () => replies.shift() ?? '{"kind":"snapshot"}',
      intent: FULL,
      startUrl: "https://example.com",
      holdBlockId: "h1",
      holds: { annotate: async (id, title) => { annotated.push([id, title]); } },
    });
    expect(result).toEqual({ status: "booked", summary: "Booked Nobu Fri 7:30pm for 2, ref X1", hold_block_id: "h1" });
    expect(seen).toEqual(["open", "go:https://example.com", "click:#reserve"]);
    expect(seen).not.toContain("close");
    expect(annotated).toEqual([["h1", finalHoldTitle(FULL, "booked")]]);
    expect(finalHoldTitle(FULL, "booked")).toBe("Nobu — 2, Fri 7:30pm (booked)");
  });

  it("hands unclear pages and login walls to the user, window open", async () => {
    const login = await runBookingLoop({
      driver: stubDriver([]),
      model: async () => '{"kind":"type","selector":"#password","text":"x"}',
      intent: FULL,
      startUrl: "https://example.com",
      holdBlockId: null,
    });
    expect(login.status).toBe("needs_user");
    expect((login as { question: string }).question).toMatch(/login/i);

    const vague = await runBookingLoop({
      driver: stubDriver([]),
      model: async () => "not json at all",
      intent: FULL,
      startUrl: "https://example.com",
      holdBlockId: null,
    });
    expect(vague.status).toBe("needs_user");
  });

  it("caps runaway runs and annotates the hold failed", async () => {
    const annotated: [string, string][] = [];
    const result = await runBookingLoop({
      driver: stubDriver([]),
      model: async () => '{"kind":"snapshot"}',
      intent: FULL,
      startUrl: "https://example.com",
      holdBlockId: "h9",
      holds: { annotate: async (id, title) => { annotated.push([id, title]); } },
      maxSteps: 3,
    });
    expect(result.status).toBe("failed");
    expect((result as { deep_link: string }).deep_link).toBe("https://example.com");
    expect(annotated).toEqual([["h9", finalHoldTitle(FULL, "failed")]]);
  });
});
