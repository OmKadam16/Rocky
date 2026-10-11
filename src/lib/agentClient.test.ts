import { describe, expect, it } from "vitest";
import { announceFor, getAgentView, reduceAgentEvent, type AgentEvent, type AgentView } from "./agentClient";

const run = (events: AgentEvent[]): AgentView => events.reduce(reduceAgentEvent, getAgentView());

describe("agent view + announcements", () => {
  it("relays the agent's question verbatim", () => {
    const v = run([{ type: "question", question: "Indoor or outdoor seating?", field: "seating" }]);
    expect(v.phase).toBe("question");
    expect(v.announce).toBe("Indoor or outdoor seating?");
    expect(v.status).toBe("Waiting for your answer");
  });

  it("several questions in one run each announce once", () => {
    const v = run([
      { type: "question", question: "A?", field: "a" },
      { type: "status", state: "running", text: "Filling form" },
      { type: "question", question: "B?", field: "b" },
    ]);
    expect(v.question).toBe("B?");
    expect(v.seq - getAgentView().seq).toBe(2);
  });

  it("final confirmation asks for an explicit yes and carries the screenshot", () => {
    const v = run([{ type: "needs_confirmation", kind: "final", summary: "Fade Co, Sat 3pm, Alex Kim.", screenshot: "data:image/png;base64,X" }]);
    expect(v.announce).toBe("Ready to book: Fade Co, Sat 3pm, Alex Kim. Say yes to book it, or no to stop.");
    expect(v.screenshot).toMatch(/^data:image/);
  });

  it("booked only with the agent's evidence; unclear says so", () => {
    const base = { url: "", screenshot: null, holdBlockId: "h", confirmationText: "Your reservation is confirmed." };
    expect(announceFor({ type: "done", status: "booked", reference: "RK-1", ...base })).toBe("Booked. Reference RK-1. It's on your calendar.");
    const unclear = announceFor({ type: "done", status: "unclear", reference: null, ...base }) as string;
    expect(unclear).toMatch(/not sure it went through/);
    expect(unclear).not.toMatch(/\bbooked\b/i);
  });

  it("handoffs and failures say what to do next", () => {
    expect(run([{ type: "needs_user_takeover", reason: "captcha", message: "There's a CAPTCHA. Solve it yourself in the window, then say continue." }]).status).toBe(
      "Needs you in the browser window",
    );
    expect(announceFor({ type: "failed", reason: "Hit the 40-step limit (last step: clicked 'Next')", holdBlockId: "h" })).toMatch(/finish by hand/);
    expect(announceFor({ type: "cancelled", message: "Stopped.", holdBlockId: "h" })).toBe("Stopped. I've taken the hold off your calendar.");
  });

  it("logs human-readable steps", () => {
    const v = run([
      { type: "step", n: 1, text: "clicked 'Reserve'" },
      { type: "step", n: 2, text: "held back from clicked 'Confirm reservation' (needs your yes)", blocked: true },
    ]);
    expect(v.log).toEqual([
      { text: "clicked 'Reserve'", blocked: false },
      { text: "held back from clicked 'Confirm reservation' (needs your yes)", blocked: true },
    ]);
  });
});

describe("progress lines in the view", () => {
  it("show as the status line while working, never over a pause", () => {
    const base = { ...getAgentView(), phase: "running" as const };
    const v = reduceAgentEvent(base, { type: "progress", text: "Checking availability." });
    expect(v).toMatchObject({ status: "Checking availability.", progress: "Checking availability.", progressSeq: base.progressSeq + 1 });
    expect(v.seq).toBe(base.seq); // not an announcement: no chat bubble, no queue
    const paused = reduceAgentEvent({ ...base, phase: "question", status: "Waiting for your answer" }, { type: "progress", text: "Still on it." });
    expect(paused.status).toBe("Waiting for your answer");
  });
});
