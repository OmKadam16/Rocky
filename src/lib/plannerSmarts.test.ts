import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixedCommitmentRow, ScheduledBlockRow } from "../../shared/db";

// In-memory calendar for runTool: two Nobu blocks today, one tomorrow, a class today.
const blocks = new Map<string, ScheduledBlockRow>();
const commitments: FixedCommitmentRow[] = [];
vi.mock("./db", () => ({
  db: {
    scheduled_blocks: {
      toArray: async () => [...blocks.values()],
      delete: async (id: string) => void blocks.delete(id),
      put: async (b: ScheduledBlockRow) => void blocks.set(b.id, b),
    },
    fixed_commitments: { toArray: async () => commitments },
  },
}));

import { runTool, selectBlocksForBulkDelete } from "./plannerTools";
import { calendarGlance, blockKind } from "./calendarGlance";
import { speedParams } from "./plannerLocal";
import { SYSTEM_PROMPT } from "./plannerPrompt";
import { ackKind, pickAck, startThinkingAck, ACK_DELAY_MS, STILL_MS } from "./thinkingAck";

const TODAY = "2026-10-11";
const TOMORROW = "2026-10-12";
const block = (id: string, title: string, date: string, start: string, end: string, source_type: "event" | "task" = "event"): ScheduledBlockRow =>
  ({ id, title, date, start_time: start, end_time: end, source_type, source_id: null, notes: null, previous_start_time: null, created_at: "" }) as unknown as ScheduledBlockRow;

beforeEach(() => {
  blocks.clear();
  commitments.length = 0;
  for (const b of [
    block("b1", "Nobu", TODAY, "07:00", "09:00"),
    block("b2", "Nobu Newport Beach", TODAY, "19:00", "21:00"),
    block("b3", "Study", TOMORROW, "10:00", "12:00", "task"),
  ])
    blocks.set(b.id, b);
  commitments.push({ id: "c1", name: "Chem 101", days_of_week: [0], start_time: "10:00", end_time: "11:30" } as unknown as FixedCommitmentRow);
});

describe("delete_blocks: clearing several blocks with one confirmation", () => {
  it("previews every block today (not tomorrow's, never fixed commitments), deletes nothing", async () => {
    const r = (await runTool("delete_blocks", { date: TODAY })) as Record<string, unknown>;
    expect(r.needs_confirmation).toBe(true);
    expect(r.count).toBe(2);
    expect(r.block_ids).toEqual(["b1", "b2"]);
    expect(r.fixed_commitments_that_stay).toEqual(["Chem 101"]);
    expect(String(r.preview)).toMatch(/Nobu .*07:00-09:00; Nobu Newport Beach .*19:00-21:00\? Say yes or tap Confirm/);
    expect(blocks.size).toBe(3);
  });

  it("after yes deletes the whole previewed list in one call, even without ids", async () => {
    await runTool("delete_blocks", { date: TODAY });
    const r = (await runTool("delete_blocks", { date: TODAY, confirmed: true })) as Record<string, unknown>;
    expect(r.deleted).toBe(2);
    expect([...blocks.keys()]).toEqual(["b3"]);
  });

  it("filters by time window and title words", () => {
    const all = [...blocks.values()];
    const evening = selectBlocksForBulkDelete(all, { date: TODAY, endDate: TODAY, from: 12 * 60, to: null, query: "" });
    expect(evening.map((b) => b.id)).toEqual(["b2"]);
    const nobu = selectBlocksForBulkDelete(all, { date: TODAY, endDate: TOMORROW, from: null, to: null, query: "nobu" });
    expect(nobu.map((b) => b.id)).toEqual(["b1", "b2"]);
    const both = selectBlocksForBulkDelete(all, { date: TODAY, endDate: TOMORROW, from: null, to: null, query: "" });
    expect(both.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("says plainly when there's nothing to delete", async () => {
    const r = (await runTool("delete_blocks", { date: "2026-10-20" })) as Record<string, unknown>;
    expect(r.nothing_to_delete).toBe(true);
  });
});

describe("calendar at a glance", () => {
  const snap = {
    today: TODAY,
    tomorrow: TOMORROW,
    now: "12:00",
    week: {
      days: [
        {
          date: TODAY,
          weekday: "Sunday",
          free_windows: [{ start_time: "09:00", end_time: "10:00" }, { start_time: "11:45", end_time: "19:00" }],
          fixed_commitments: [{ id: "c1", name: "Chem 101", start_time: "10:00", end_time: "11:30" }],
          blocks: [
            { id: "b2", title: "Nobu Newport Beach", source_type: "event", start_time: "19:00", end_time: "21:00" },
            { id: "b1", title: "Nobu", source_type: "event", start_time: "07:00", end_time: "09:00" },
          ],
        },
        { date: TOMORROW, weekday: "Monday", free_windows: [], fixed_commitments: [], blocks: [] },
      ],
    },
    tasks: [{ name: "Essay", deadline: "2026-10-14", estimated_duration: 120, priority: "high", status: "pending" }],
  };

  it("lists each day in time order with kind, status and id", () => {
    const g = calendarGlance(snap);
    const today = g.split("TOMORROW")[0];
    expect(today).toMatch(/TODAY, Sunday 2026-10-11 \(it is 12:00 now\)/);
    expect(today.indexOf("07:00-09:00 Nobu")).toBeLessThan(today.indexOf("10:00-11:30 Chem 101"));
    expect(today.indexOf("10:00-11:30 Chem 101")).toBeLessThan(today.indexOf("19:00-21:00 Nobu Newport Beach"));
    expect(g).toMatch(/07:00-09:00 Nobu \(event, already over\) \[b1\]/);
    expect(g).toMatch(/19:00-21:00 Nobu Newport Beach \(event, later today\) \[b2\]/);
    expect(g).toMatch(/Chem 101 \(fixed commitment: recurring, never moves/);
    expect(g).toMatch(/totals: 2 blocks, 1 fixed commitment/);
    expect(g).toMatch(/free: 09:00-10:00, 11:45-19:00/);
    expect(g).toMatch(/TOMORROW, Monday 2026-10-12:\n {2}nothing scheduled/);
    expect(g).toMatch(/Essay, due 2026-10-14, ~120 min, high priority/);
  });

  it("names booking holds and task blocks", () => {
    expect(blockKind({ title: "(booking hold) Nobu", source_type: "event" })).toMatch(/NOT a reservation/);
    expect(blockKind({ title: "Essay", source_type: "task" })).toBe("task block");
  });
});

describe("planner speed and prompt", () => {
  it("GPT-5 models on OpenAI run at low reasoning effort; others untouched", () => {
    expect(speedParams("OpenAI", "gpt-5-nano")).toEqual({ reasoning_effort: "low", verbosity: "low" });
    expect(speedParams("OpenAI", "gpt-5.4-mini")).toEqual({ reasoning_effort: "low", verbosity: "low" });
    expect(speedParams("OpenAI", "gpt-4o")).toEqual({});
    expect(speedParams("Gemini", "gemini-3.5-flash")).toEqual({});
  });

  it("the prompt explains the calendar and the one-confirmation bulk delete", () => {
    expect(SYSTEM_PROMPT).toMatch(/THE CALENDAR: what it is made of/);
    expect(SYSTEM_PROMPT).toMatch(/Fixed commitments are NOT included unless the user names them/);
    expect(SYSTEM_PROMPT).toMatch(/ONE delete_blocks call/);
    expect(SYSTEM_PROMPT).toMatch(/Never delete only the first one/);
    expect(SYSTEM_PROMPT).toMatch(/Never start with "One moment"/);
  });
});

describe("spoken 'one moment' while the planner thinks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("picks a line that fits the request", () => {
    expect(ackKind("Can you remove all the blocks we have today?")).toBe("remove");
    expect(ackKind("add gym tomorrow at 7pm")).toBe("change");
    expect(ackKind("what's on tomorrow")).toBe("question");
    expect(ackKind("yes")).toBe("yes");
    expect(pickAck("remove everything today", () => 0)).toBe("One moment, let me find those.");
  });

  it("says nothing when the reply is quick", async () => {
    const say = vi.fn(async () => {});
    const ack = startThinkingAck("add gym", say);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS - 100);
    await ack.finish();
    await vi.advanceTimersByTimeAsync(STILL_MS);
    expect(say).not.toHaveBeenCalled();
  });

  it("says one line after a beat, one more if it's slow, and the reply waits for it", async () => {
    let end: () => void = () => {};
    const say = vi.fn((_line: string) => new Promise<void>((r) => (end = r)));
    const ack = startThinkingAck("remove all the blocks today", say, { random: () => 0 });
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0]).toBe("One moment, let me find those.");
    end();
    await vi.advanceTimersByTimeAsync(STILL_MS);
    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1][0]).toBe("Still on it.");
    let finished = false;
    void ack.finish().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false); // still playing "Still on it."
    end();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
  });
});
