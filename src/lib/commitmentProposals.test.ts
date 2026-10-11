import { beforeEach, describe, expect, it } from "vitest";
import type { FixedCommitmentRow } from "../../shared/db";
import {
  cancelProposal,
  commitmentReply,
  confirmProposal,
  conflictsFor,
  createProposal,
  editProposal,
  getProposal,
  parseDays,
  resetProposals,
  summarize,
  type CommitmentStore,
} from "./commitmentProposals";
import { resetCommitmentDraft, runCommitmentTool } from "./commitmentTools";
import { pendingProposalId } from "./chatCards";
import { buildDay } from "./schedule";
import type { CommitmentFields } from "../types";

function fakeStore(initial: FixedCommitmentRow[] = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const writes: string[] = [];
  const store: CommitmentStore = {
    list: async () => [...rows.values()],
    put: async (r) => {
      writes.push(`put:${r.name}`);
      rows.set(r.id, r);
    },
    remove: async (id) => {
      writes.push(`remove:${id}`);
      rows.delete(id);
    },
  };
  return { store, rows, writes };
}

const LAB: FixedCommitmentRow = { id: "lab", name: "Chem Lab", type: "Class", days_of_week: [1], start_time: "11:00", end_time: "13:00" } as FixedCommitmentRow;
const CHEM: CommitmentFields = { name: "Chem 101", type: "Class", days_of_week: [1, 2], start_time: "10:00", end_time: "11:30", active_from: null, active_until: null, notes: null };

beforeEach(() => {
  resetProposals();
  resetCommitmentDraft();
});

describe("propose -> confirm: only Confirm writes", () => {
  it("a proposal writes nothing", async () => {
    const { store, writes } = fakeStore();
    const r = (await runCommitmentTool("propose_commitment", { name: "Chem 101", type: "Class", days_of_week: [1, 2], start_time: "10:00", end_time: "11:30" }, store)) as any;
    expect(r.proposal_id).toBeTruthy();
    expect(r.summary).toBe("Chem 101 · Mon, Tue · 10:00–11:30");
    expect(writes).toEqual([]);
  });

  it("confirm writes once; a double confirm (even concurrent) is idempotent", async () => {
    const { store, writes, rows } = fakeStore();
    const p = await createProposal("add", CHEM, null, store);
    const [a, b] = await Promise.all([confirmProposal(p.id, store), confirmProposal(p.id, store)]);
    const c = await confirmProposal(p.id, store);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(c.already).toBe(true);
    expect(writes).toEqual(["put:Chem 101"]);
    expect([...rows.values()][0]).toMatchObject({ name: "Chem 101", days_of_week: [1, 2], start_time: "10:00", end_time: "11:30" });
  });

  it("cancel writes nothing, and a later confirm can't revive it", async () => {
    const { store, writes } = fakeStore();
    const p = await createProposal("add", CHEM, null, store);
    expect(cancelProposal(p.id)).toBe(true);
    expect((await confirmProposal(p.id, store)).ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("a newer proposal replaces an older pending one", async () => {
    const { store } = fakeStore();
    const a = await createProposal("add", CHEM, null, store);
    await createProposal("add", { ...CHEM, start_time: "10:30" }, null, store);
    expect(getProposal(a.id)?.status).toBe("replaced");
  });

  it("undo removes what confirm wrote", async () => {
    const { store, rows } = fakeStore();
    const p = await createProposal("add", CHEM, null, store);
    const r = await confirmProposal(p.id, store);
    await r.undo?.();
    expect(rows.size).toBe(0);
  });
});

describe("one question at a time, never invented times", () => {
  it("asks name, days, start, end in turn and keeps earlier answers", async () => {
    const { store, writes } = fakeStore();
    expect(((await runCommitmentTool("propose_commitment", {}, store)) as any).question).toBe("What should I call it?");
    expect(((await runCommitmentTool("propose_commitment", { name: "Shift", type: "Work" }, store)) as any).question).toBe("Which days of the week?");
    expect(((await runCommitmentTool("propose_commitment", { days_of_week: [5] }, store)) as any).question).toBe("What time does it start?");
    expect(((await runCommitmentTool("propose_commitment", { start_time: "16:00" }, store)) as any).question).toBe("And what time does it end?");
    const done = (await runCommitmentTool("propose_commitment", { end_time: "21:00" }, store)) as any;
    expect(done.summary).toBe("Shift · Fri · 16:00–21:00");
    expect(writes).toEqual([]);
  });

  it("rejects an end before the start instead of guessing", async () => {
    const { store } = fakeStore();
    const r = (await runCommitmentTool("propose_commitment", { name: "Gym", days_of_week: [1], start_time: "18:00", end_time: "17:00" }, store)) as any;
    expect(r.error).toMatch(/after start_time/);
  });

  it("carries an until date ('work Saturdays 9-5 until December 12')", async () => {
    const { store } = fakeStore();
    const r = (await runCommitmentTool("propose_commitment", { name: "Work", type: "Work", days_of_week: [6], start_time: "9:00", end_time: "17:00", active_until: "2026-12-12" }, store)) as any;
    expect(r.summary).toBe("Work · Sat · 09:00–17:00 · until Dec 12");
  });

  it("days parse from numbers, strings and names", () => {
    expect(parseDays([1, 2])).toEqual([1, 2]);
    expect(parseDays("2,1")).toEqual([1, 2]);
    expect(parseDays(["Mon", "tuesday"])).toEqual([1, 2]);
    expect(parseDays([7, -1, "x"])).toEqual([]);
  });
});

describe("conflicts are shown before confirming", () => {
  it("names the overlapping commitment, day and hours", async () => {
    const { store } = fakeStore([LAB]);
    const p = await createProposal("add", CHEM, null, store);
    expect(p.conflicts).toEqual(["Overlaps Chem Lab on Mon 11:00–13:00"]);
  });

  it("no conflict on other days, other hours, or non-overlapping date ranges", () => {
    expect(conflictsFor({ ...CHEM, days_of_week: [3] }, [LAB])).toEqual([]);
    expect(conflictsFor({ ...CHEM, start_time: "08:00", end_time: "11:00" }, [LAB])).toEqual([]);
    expect(conflictsFor({ ...CHEM, active_until: "2026-09-01" }, [{ ...LAB, active_from: "2026-10-01" } as FixedCommitmentRow])).toEqual([]);
  });

  it("an edit on the card re-checks conflicts", async () => {
    const { store } = fakeStore([LAB]);
    const p = await createProposal("add", CHEM, null, store);
    await editProposal(p.id, { days_of_week: [2] }, store);
    expect(getProposal(p.id)?.conflicts).toEqual([]);
    expect(summarize(getProposal(p.id)!.fields)).toBe("Chem 101 · Tue · 10:00–11:30");
  });
});

describe("change and removal also go through a card", () => {
  it("removal deletes only after confirm", async () => {
    const { store, rows, writes } = fakeStore([LAB]);
    const r = (await runCommitmentTool("propose_commitment_removal", { commitment_query: "chem lab" }, store)) as any;
    expect(rows.has("lab")).toBe(true);
    await confirmProposal(r.proposal_id, store);
    expect(writes).toEqual(["remove:lab"]);
  });

  it("change keeps the id and only the changed fields", async () => {
    const { store, rows } = fakeStore([LAB]);
    const r = (await runCommitmentTool("propose_commitment_change", { commitment_query: "Chem Lab", start_time: "12:00", end_time: "14:00" }, store)) as any;
    await confirmProposal(r.proposal_id, store);
    expect(rows.get("lab")).toMatchObject({ id: "lab", name: "Chem Lab", days_of_week: [1], start_time: "12:00", end_time: "14:00" });
  });

  it("an unknown name asks which one", async () => {
    const { store } = fakeStore([LAB]);
    expect(((await runCommitmentTool("propose_commitment_removal", { commitment_query: "yoga" }, store)) as any).question).toMatch(/can't find/);
  });
});

describe("recurrence lands on the right weekdays", () => {
  it("shows Mon + Tue, not Wed, and stops after active_until", async () => {
    const { store, rows } = fakeStore();
    const p = await createProposal("add", { ...CHEM, active_until: "2026-10-20" }, null, store);
    await confirmProposal(p.id, store);
    const source = { blocks: [], commitments: [...rows.values()] };
    const ctx = { today: "2026-10-12", now: "08:00" };
    const titles = (date: string) => buildDay(date, source, ctx).events.map((e) => e.title);
    expect(titles("2026-10-12")).toContain("Chem 101"); // Monday
    expect(titles("2026-10-13")).toContain("Chem 101"); // Tuesday
    expect(titles("2026-10-14")).not.toContain("Chem 101"); // Wednesday
    expect(titles("2026-10-26")).not.toContain("Chem 101"); // Monday after active_until
  });
});

describe("spoken yes confirms only a pending proposal", () => {
  it("yes / no act on the latest pending card, nothing else", async () => {
    const { store } = fakeStore();
    const p = await createProposal("add", CHEM, null, store);
    const turns = [
      { role: "user", text: "chem 101 mon tue 10 to 11:30" },
      { role: "assistant", text: "Here it is.", card: { kind: "commitment" as const, proposalId: p.id, op: "add" as const, fields: CHEM, conflicts: [] } },
    ];
    const id = pendingProposalId(turns);
    expect(commitmentReply("yes", id)).toEqual({ action: "confirm", id: p.id });
    expect(commitmentReply("commit it", id)).toEqual({ action: "confirm", id: p.id });
    expect(commitmentReply("cancel", id)).toEqual({ action: "cancel", id: p.id });
    expect(commitmentReply("make it 10:30 instead", id)).toBe(null); // goes to the planner
    // A later plain assistant reply means the card is no longer what "yes" answers.
    expect(pendingProposalId([...turns, { role: "assistant", text: "Anything else?" }])).toBe(null);
    // Nothing pending: a yes does nothing here.
    cancelProposal(p.id);
    expect(commitmentReply("yes", pendingProposalId(turns))).toBe(null);
  });
});
