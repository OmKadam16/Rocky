import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityFor, EVERY_MS, FILLERS, FIRST_MS, ProgressTalker, SLOW_MS } from "./progressTalker";

function talker(opts: { busy?: () => boolean } = {}) {
  const said: { text: string; at: number }[] = [];
  const cancel = vi.fn();
  const t = new ProgressTalker({ emit: (text) => said.push({ text, at: Date.now() }), cancel, busy: opts.busy, random: () => 0 });
  return { t, said, cancel };
}

const running = { type: "status", state: "running", text: "Working" } as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("progress talker", () => {
  it("first filler at ~3s of quiet, then no more than one every ~8s", () => {
    const { t, said } = talker();
    t.handle(running);
    vi.advanceTimersByTime(FIRST_MS - 600);
    expect(said).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(said).toHaveLength(1);
    expect(said[0].at).toBeGreaterThanOrEqual(FIRST_MS);
    expect(said[0].at).toBeLessThanOrEqual(FIRST_MS + 600);
    vi.advanceTimersByTime(20_000);
    for (let i = 1; i < said.length; i += 1) expect(said[i].at - said[i - 1].at).toBeGreaterThanOrEqual(EVERY_MS);
    expect(said.length).toBeGreaterThanOrEqual(2);
    t.stop();
  });

  it("never says the same line twice in a row", () => {
    const { t, said } = talker();
    t.handle(running);
    // Keep the agent visibly busy so the state stays the same.
    for (let i = 0; i < 120; i += 1) {
      vi.advanceTimersByTime(500);
      if (i % 4 === 0) t.handle({ type: "step", n: i, text: "typed name" });
    }
    expect(said.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < said.length; i += 1) expect(said[i].text).not.toBe(said[i - 1].text);
    expect(said.every((s) => FILLERS.filling.includes(s.text))).toBe(true);
    t.stop();
  });

  it("lines match what the agent is doing, and every line is short", () => {
    expect(activityFor({ type: "status", state: "running", text: "Opening page" })).toBe("opening");
    expect(activityFor({ type: "step", n: 1, text: "clicked '7:00 PM'" })).toBe("searching");
    expect(activityFor({ type: "step", n: 1, text: "typed email address" })).toBe("filling");
    expect(activityFor({ type: "step", n: 1, text: "waited for the page" })).toBe("waiting");
    for (const [state, lines] of Object.entries(FILLERS)) {
      expect(lines.length).toBeGreaterThanOrEqual(2);
      if (state !== "slow") for (const l of lines) expect(l.split(/\s+/).length).toBeLessThanOrEqual(7);
    }
  });

  it("a long stall says the site is slow and mentions stop", () => {
    const { t, said } = talker();
    t.handle(running);
    vi.advanceTimersByTime(SLOW_MS + EVERY_MS + 1000);
    expect(said.some((s) => FILLERS.slow.includes(s.text) && /stop/.test(s.text))).toBe(true);
    t.stop();
  });

  it("a real event silences it at once and cancels a filler in flight", () => {
    for (const real of [
      { type: "question", question: "Indoor or outdoor?", field: "seating" },
      { type: "needs_confirmation", kind: "final", summary: "x", screenshot: null },
      { type: "needs_user_takeover", reason: "captcha", message: "Solve it" },
      { type: "done", status: "booked", reference: "R1", confirmationText: "", url: "", screenshot: null, holdBlockId: null },
      { type: "failed", reason: "x", holdBlockId: null },
      { type: "cancelled", message: "Stopped.", holdBlockId: null },
    ] as const) {
      const { t, said, cancel } = talker();
      t.handle(running);
      vi.advanceTimersByTime(FIRST_MS + 500);
      expect(said).toHaveLength(1);
      t.handle(real);
      expect(cancel).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(said).toHaveLength(1);
    }
  });

  it("stays quiet while the user is talking or real speech plays", () => {
    let busy = true;
    const { t, said } = talker({ busy: () => busy });
    t.handle(running);
    vi.advanceTimersByTime(30_000);
    expect(said).toHaveLength(0);
    busy = false;
    vi.advanceTimersByTime(FIRST_MS - 600);
    expect(said).toHaveLength(0); // the quiet clock restarted when they stopped
    vi.advanceTimersByTime(1000);
    expect(said).toHaveLength(1);
    t.stop();
  });

  it("real announcements reset the quiet clock", () => {
    const { t, said } = talker();
    t.handle(running);
    vi.advanceTimersByTime(2000);
    t.noteSpeech("Got it."); // a short real reply
    vi.advanceTimersByTime(2500);
    expect(said).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    expect(said).toHaveLength(1);
    t.stop();
  });

  it("no filler while the run is paused waiting for the user, and again after resume", () => {
    const { t, said } = talker();
    t.handle(running);
    t.handle({ type: "question", question: "Phone?", field: "phone" });
    vi.advanceTimersByTime(120_000);
    expect(said).toHaveLength(0);
    t.handle({ type: "status", state: "running", text: "Filling form" });
    vi.advanceTimersByTime(FIRST_MS + 500);
    expect(said.map((s) => s.text)).toEqual([FILLERS.filling[0]]);
    t.stop();
  });
});

describe("echo guard", () => {
  it("drops a transcript of Rocky's own filler, keeps real answers", async () => {
    const { isEchoOf } = await import("../hooks/useAssistant");
    expect(isEchoOf("Checking availability", ["Checking availability."])).toBe(true);
    expect(isEchoOf("one moment checking that", ["One moment, checking that."])).toBe(true);
    expect(isEchoOf("outdoor please", ["Checking availability."])).toBe(false);
    // "stop" right after "say stop any time" is the user, never an echo.
    expect(isEchoOf("stop", ["This site is slow, still on it. You can say stop any time."])).toBe(false);
    expect(isEchoOf("stop it", ["This site is slow, still on it. You can say stop any time."])).toBe(false);
  });
});
