import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledBlockRow } from "../../shared/db";

// The agent backend is stubbed: these tests never open a window or call a model.
const agent = vi.hoisted(() => ({
  available: true,
  phase: "idle" as string,
  started: [] as unknown[],
  answers: [] as string[],
  confirms: [] as boolean[],
}));
vi.mock("./agentClient", () => ({
  agentAvailable: () => agent.available,
  getAgentView: () => ({ phase: agent.phase, question: "Indoor or outdoor?", message: "Solve the CAPTCHA" }),
  isAgentActive: () => ["running", "question", "confirm", "takeover"].includes(agent.phase),
  startAgent: async (t: unknown) => {
    agent.started.push(t);
    return { ok: true };
  },
  answerAgent: async (t: string) => {
    agent.answers.push(t);
    return true;
  },
  continueAgent: async () => agent.phase === "takeover",
  confirmAgent: async (y: boolean) => {
    agent.confirms.push(y);
    return true;
  },
  cancelAgent: async () => true,
}));

import { resetBookingState, runBookingTool, type CalendarHelpers } from "./bookingTools";
import { agentFastPath } from "../hooks/useAssistant";

function calendar(opts: { fixedClash?: boolean } = {}) {
  const blocks: ScheduledBlockRow[] = [];
  const cal: CalendarHelpers = {
    loadBlocks: async (from) => blocks.filter((b) => b.date === from),
    insertBlock: async (row) => {
      const b = { ...row, id: `b${blocks.length + 1}`, previous_start_time: null, created_at: "" } as ScheduledBlockRow;
      blocks.push(b);
      return { id: b.id };
    },
    updateBlock: async (id, patch) => {
      Object.assign(blocks.find((b) => b.id === id) as ScheduledBlockRow, patch);
    },
    fixedOverlapError: async () => (opts.fixedClash ? { error: "Overlaps your fixed commitment Chem Lab." } : null),
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

const FULL = {
  type: "appointment",
  venue: "Fade Co",
  area: "Pune",
  date: "2099-10-17",
  start_time: "15:00",
  service: "haircut",
  first_name: "Alex",
  last_name: "Kim",
  phone: "555-0100",
  email: "alex@example.com",
};

beforeEach(() => {
  resetBookingState();
  agent.available = true;
  agent.phase = "idle";
  agent.started = [];
  agent.answers = [];
  agent.confirms = [];
});

describe("propose_booking: one question at a time, then a hold + full plan", () => {
  it("builds the draft across turns and asks only for what's missing", async () => {
    const { cal, blocks } = calendar();
    const r1 = (await runBookingTool("propose_booking", { type: "appointment", venue: "Fade Co", area: "Pune", date: "2099-10-17", start_time: "15:00" }, {}, cal)) as any;
    expect(r1.question).toBe("Which service do you want?");
    expect(r1.needs).toContain("phone");
    // Next turn passes only the answer: earlier details are kept.
    const r2 = (await runBookingTool("propose_booking", { service: "haircut", first_name: "Alex", last_name: "Kim" }, {}, cal)) as any;
    expect(r2.question).toBe("What phone number should I put down?");
    expect(blocks).toHaveLength(0);
    const r3 = (await runBookingTool("propose_booking", { phone: "555-0100", email: "alex@example.com" }, {}, cal)) as any;
    expect(r3.proposed).toBe(true);
    expect(r3.summary).toMatch(/^Haircut at Fade Co in Pune, Saturday 3pm, name Alex Kim, phone 555-0100, email alex@example.com/);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ title: "Haircut — Fade Co (booking…)", start_time: "15:00", end_time: "16:00" });
  });

  it("fixed commitments win", async () => {
    const { cal, blocks } = calendar({ fixedClash: true });
    const r = (await runBookingTool("propose_booking", FULL, {}, cal)) as any;
    expect(r.error).toMatch(/fixed commitment/);
    expect(blocks).toHaveLength(0);
  });

  it("re-proposing moves the hold instead of stacking a second", async () => {
    const { cal, blocks } = calendar();
    await runBookingTool("propose_booking", FULL, {}, cal);
    await runBookingTool("propose_booking", { ...FULL, start_time: "16:30" }, {}, cal);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start_time).toBe("16:30");
  });
});

describe("book_appointment: confirmation #1 is checked in code", () => {
  it("won't start without the user's own yes this turn, even with confirmed:true", async () => {
    const { cal } = calendar();
    const p = (await runBookingTool("propose_booking", FULL, {}, cal)) as any;
    const r = (await runBookingTool("book_appointment", { hold_block_id: p.hold_block_id, confirmed: true }, { userText: "what's the weather" }, cal)) as any;
    expect(r.error).toMatch(/hasn't said yes/);
    expect(agent.started).toHaveLength(0);
  });

  it("starts the agent on a real yes and never reports booked itself", async () => {
    const { cal } = calendar();
    const p = (await runBookingTool("propose_booking", FULL, {}, cal)) as any;
    const r = (await runBookingTool("book_appointment", { hold_block_id: p.hold_block_id, confirmed: true }, { userText: "yes" }, cal)) as any;
    expect(r.status).toBe("started");
    expect(agent.started[0]).toMatchObject({ type: "appointment", venue: "Fade Co", holdBlockId: p.hold_block_id, details: { service: "haircut" } });
    expect(JSON.stringify(r)).not.toMatch(/"status":"booked"/);
  });

  it("a yes without the hold id (history is text-only) books the plan just read back", async () => {
    const { cal } = calendar();
    const p = (await runBookingTool("propose_booking", FULL, {}, cal)) as any;
    const r = (await runBookingTool("book_appointment", { confirmed: true }, { userText: "yes please" }, cal)) as any;
    expect(r.status).toBe("started");
    expect(agent.started[0]).toMatchObject({ holdBlockId: p.hold_block_id });
  });

  it("without the desktop app it hands over a link", async () => {
    agent.available = false;
    const { cal } = calendar();
    const p = (await runBookingTool("propose_booking", FULL, {}, cal)) as any;
    const r = (await runBookingTool("book_appointment", { hold_block_id: p.hold_block_id, confirmed: true }, { userText: "yes" }, cal)) as any;
    expect(r.status).toBe("needs_desktop");
    expect(r.deep_link).toMatch(/^https:\/\/www\.google\.com\/search/);
  });
});

describe("pause/resume handoff", () => {
  it("answer_agent_question forwards the user's exact words, not the planner's rewrite", async () => {
    agent.phase = "question";
    const { cal } = calendar();
    await runBookingTool("answer_agent_question", { answer: "Outdoor seating preferred." }, { userText: "outside if it's not raining" }, cal);
    expect(agent.answers).toEqual(["outside if it's not raining"]);
  });

  it("the planner cannot answer when no question is pending (e.g. the final confirmation)", async () => {
    agent.phase = "confirm";
    const { cal } = calendar();
    const r = (await runBookingTool("answer_agent_question", { answer: "yes" }, { userText: "yes" }, cal)) as any;
    expect(r.error).toBeTruthy();
    expect(agent.answers).toHaveLength(0);
    expect(agent.confirms).toHaveLength(0);
  });

  it("continue_agent only works during a takeover", async () => {
    const { cal } = calendar();
    agent.phase = "running";
    expect(((await runBookingTool("continue_agent", {}, {}, cal)) as any).error).toBeTruthy();
    agent.phase = "takeover";
    expect(((await runBookingTool("continue_agent", {}, {}, cal)) as any).status).toBe("continuing");
  });
});

describe("voice fast path (confirmation #2 never goes through the planner)", () => {
  it("a spoken yes approves the final click directly", async () => {
    agent.phase = "confirm";
    expect(await agentFastPath("yes")).toBe("Booking it now.");
    expect(agent.confirms).toEqual([true]);
  });

  it("anything that isn't a clear yes or no re-asks instead of approving", async () => {
    agent.phase = "confirm";
    expect(await agentFastPath("hmm maybe make it later")).toBe("Say yes to book it, or no to stop.");
    expect(agent.confirms).toEqual([]);
    expect(await agentFastPath("no")).toBe(null);
    expect(agent.confirms).toEqual([false]);
  });

  it("a takeover resumes on 'continue'; ordinary questions go to the planner", async () => {
    agent.phase = "takeover";
    expect(await agentFastPath("continue")).toBe("Carrying on.");
    agent.phase = "question";
    expect(await agentFastPath("outdoor please")).toBe(null);
  });
});
