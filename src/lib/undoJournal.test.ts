import { describe, expect, it } from "vitest";
import type { FixedCommitmentRow, ScheduledBlockRow } from "../../shared/db";
import { beginCapture, canUndo, describeChanges, diffRows, endCapture, runUndo, snapshotIfCapturing, type UndoStore } from "./undoJournal";

function fake() {
  const blocks = new Map<string, ScheduledBlockRow>();
  const commitments = new Map<string, FixedCommitmentRow>();
  const table = <T extends { id: string }>(m: Map<string, T>) => ({
    list: async () => [...m.values()].map((r) => ({ ...r })),
    put: async (r: T) => void m.set(r.id, { ...r }),
    remove: async (id: string) => void m.delete(id),
  });
  const store: UndoStore = { blocks: table(blocks), commitments: table(commitments) };
  return { store, blocks, commitments };
}

const block = (id: string, title: string, date: string, start: string): ScheduledBlockRow =>
  ({ id, title, date, start_time: start, end_time: "23:00", source_type: "event", source_id: null, previous_start_time: null, created_at: "" }) as ScheduledBlockRow;

describe("receipts with Undo for the last action", () => {
  it("captures a turn's changes and undoes them exactly", async () => {
    const { store, blocks } = fake();
    blocks.set("study", block("study", "Study", "2026-10-16", "18:00"));
    beginCapture(store);
    await snapshotIfCapturing();
    blocks.set("gym", block("gym", "Gym", "2026-10-17", "07:00"));
    blocks.set("study", block("study", "Study", "2026-10-16", "20:00"));
    const r = await endCapture();
    expect(r?.text).toBe("Added Gym · Sat 07:00; Moved Study to Fri 20:00");
    expect(canUndo(r!.undoId)).toBe(true);
    expect(await runUndo(r!.undoId)).toBe(true);
    expect([...blocks.keys()]).toEqual(["study"]);
    expect(blocks.get("study")?.start_time).toBe("18:00");
    expect(canUndo(r!.undoId)).toBe(false); // once only
  });

  it("read-only turns take no snapshot and give no receipt", async () => {
    const { store } = fake();
    beginCapture(store);
    expect(await endCapture()).toBe(null);
  });

  it("only the latest action can be undone", async () => {
    const { store, blocks } = fake();
    beginCapture(store);
    await snapshotIfCapturing();
    blocks.set("a", block("a", "A", "2026-10-16", "09:00"));
    const first = await endCapture();
    beginCapture(store);
    await snapshotIfCapturing();
    blocks.set("b", block("b", "B", "2026-10-16", "10:00"));
    const second = await endCapture();
    expect(canUndo(first!.undoId)).toBe(false);
    expect(canUndo(second!.undoId)).toBe(true);
  });

  it("diff + description", () => {
    const d = diffRows([{ id: "x", v: 1 }], [{ id: "x", v: 2 }, { id: "y", v: 1 }]);
    expect(d.added.map((r) => r.id)).toEqual(["y"]);
    expect(d.changed).toHaveLength(1);
    expect(describeChanges({ added: [], removed: [block("q", "Quiz", "2026-10-16", "09:00")], changed: [] }, { added: [], removed: [], changed: [] })).toBe("Removed Quiz");
  });
});
