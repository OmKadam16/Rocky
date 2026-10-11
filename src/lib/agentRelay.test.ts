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

describe("progress lines cross to the phone", () => {
  it("relays the short filler text only", () => {
    expect(sanitizeForRelay({ type: "progress", text: "Checking availability." })).toEqual({ type: "progress", text: "Checking availability." });
    expect((sanitizeForRelay({ type: "progress", text: "x".repeat(500) }) as { text: string }).text.length).toBe(80);
  });

  it("timing stays on the laptop", () => {
    const step = { n: 1, screenshotMs: 1, modelMs: 1, actionMs: 1, settleMs: 1, navMs: 1, shotKb: 1, totalMs: 5 };
    const summary = { steps: 1, totalMs: 5, avgStepMs: 5, avgModelMs: 1, avgScreenshotMs: 1, avgActionMs: 1, avgSettleMs: 1, navMs: 1, maxStepMs: 5 };
    expect(sanitizeForRelay({ type: "timing", step, summary })).toBe(null);
  });
});

describe("verification codes never cross the relay", () => {
  it("relays only where the code went, never a code", () => {
    expect(sanitizeForRelay({ type: "code_request", channel: "sms", attempt: 1 })).toEqual({ type: "code_request", channel: "sms", attempt: 1 });
    const sneaky = sanitizeForRelay({ type: "code_request", channel: "sms", attempt: 0, code: "4271" } as never);
    expect(JSON.stringify(sneaky)).not.toContain("4271");
  });

  it("there is no relay op for a code", () => {
    expect(parseRequest({ op: "code", text: "4271" })).toBe(null);
  });
});
