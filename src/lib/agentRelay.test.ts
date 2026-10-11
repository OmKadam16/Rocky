import { describe, expect, it } from "vitest";
import { parseRequest, sanitizeForRelay } from "./agentRelay";

describe("phone relay: only short text crosses Supabase", () => {
  it("never relays screenshots, page text, URLs or the step log", () => {
    expect(sanitizeForRelay({ type: "step", n: 1, text: "typed phone number" })).toBe(null);
    const conf = sanitizeForRelay({ type: "needs_confirmation", kind: "final", summary: "Fade Co Sat 3pm", screenshot: "data:image/png;base64,SECRET" });
    expect(JSON.stringify(conf)).not.toContain("SECRET");
    const done = sanitizeForRelay({
      type: "done",
      status: "booked",
      reference: "FC-1",
      confirmationText: "Thanks Alex, booking FC-1 confirmed for 555-0100",
      url: "https://fadeco.example/confirm?token=abc",
      screenshot: "data:image/png;base64,SECRET",
      holdBlockId: "h1",
    });
    expect(done).toMatchObject({ status: "booked", reference: "FC-1", holdBlockId: "h1", screenshot: null, url: "", confirmationText: "" });
    const failed = sanitizeForRelay({ type: "failed", reason: "x".repeat(1000), url: "https://a.example/secret", holdBlockId: null });
    expect(JSON.stringify(failed)).not.toContain("a.example");
    expect((failed as { reason: string }).reason.length).toBe(200);
  });

  it("keeps the question verbatim (clipped) so the phone can speak it", () => {
    expect(sanitizeForRelay({ type: "question", question: "Indoor or outdoor?", field: "seating" })).toEqual({ type: "question", question: "Indoor or outdoor?", field: "seating" });
  });

  it("validates phone requests", () => {
    expect(parseRequest({ op: "confirm", yes: true })).toEqual({ op: "confirm", yes: true });
    expect(parseRequest({ op: "confirm", yes: "yes" })).toEqual({ op: "confirm", yes: false }); // only a real boolean true approves
    expect(parseRequest({ op: "answer", text: "  " })).toBe(null);
    expect(parseRequest({ op: "rm -rf" })).toBe(null);
    expect(parseRequest(null)).toBe(null);
    expect(parseRequest({ op: "start" })).toBe(null);
  });
});
