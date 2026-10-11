/**
 * "Added to your calendar" receipts with Undo for the last action.
 *
 * A chat turn opens a capture; the first calendar-changing tool in it takes a
 * before-snapshot (lazily, so read-only turns cost nothing). When the turn
 * ends, the diff becomes one undoable entry and a receipt line. Only the
 * latest entry can be undone. Commitment confirms register their own entry.
 */
import type { FixedCommitmentRow, ScheduledBlockRow } from "../../shared/db";
import { db } from "./db";
import { emitDataChange } from "./supaDb";

type Row = { id: string };
type Table<T extends Row> = { list: () => Promise<T[]>; put: (r: T) => Promise<void>; remove: (id: string) => Promise<void> };
export type UndoStore = { blocks: Table<ScheduledBlockRow>; commitments: Table<FixedCommitmentRow> };

export const dbUndoStore: UndoStore = {
  blocks: {
    list: () => db.scheduled_blocks.toArray(),
    put: async (r) => {
      await db.scheduled_blocks.put(r);
    },
    remove: async (id) => {
      await db.scheduled_blocks.delete(id);
    },
  },
  commitments: {
    list: () => db.fixed_commitments.toArray(),
    put: async (r) => {
      await db.fixed_commitments.put(r);
    },
    remove: async (id) => {
      await db.fixed_commitments.delete(id);
    },
  },
};

export type RowDiff<T> = { added: T[]; removed: T[]; changed: { before: T; after: T }[] };

export function diffRows<T extends Row>(before: T[], after: T[]): RowDiff<T> {
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  const out: RowDiff<T> = { added: [], removed: [], changed: [] };
  for (const [id, r] of a) {
    const prev = b.get(id);
    if (!prev) out.added.push(r);
    else if (JSON.stringify(prev) !== JSON.stringify(r)) out.changed.push({ before: prev, after: r });
  }
  for (const [id, r] of b) if (!a.has(id)) out.removed.push(r);
  return out;
}

const empty = (d: RowDiff<unknown>) => !d.added.length && !d.removed.length && !d.changed.length;

const when = (b: ScheduledBlockRow) => {
  const d = new Date(`${b.date}T12:00:00`);
  const day = Number.isNaN(d.getTime()) ? b.date : d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${b.start_time.slice(0, 5)}`;
};

/** One short receipt line for a turn's calendar changes. */
export function describeChanges(blocks: RowDiff<ScheduledBlockRow>, commitments: RowDiff<FixedCommitmentRow>): string {
  const parts: string[] = [];
  for (const r of blocks.added) parts.push(`Added ${r.title} · ${when(r)}`);
  for (const c of blocks.changed) parts.push(c.before.title !== c.after.title && c.before.date === c.after.date && c.before.start_time === c.after.start_time ? `Updated ${c.after.title}` : `Moved ${c.after.title} to ${when(c.after)}`);
  for (const r of blocks.removed) parts.push(`Removed ${r.title}`);
  for (const r of commitments.added) parts.push(`Added ${r.name} to fixed commitments`);
  for (const c of commitments.changed) parts.push(`Updated ${c.after.name}`);
  for (const r of commitments.removed) parts.push(`Removed ${r.name}`);
  if (parts.length <= 3) return parts.join("; ");
  return `${parts.slice(0, 2).join("; ")}; and ${parts.length - 2} more changes`;
}

async function restore<T extends Row>(t: Table<T>, d: RowDiff<T>) {
  for (const r of d.added) await t.remove(r.id);
  for (const r of d.removed) await t.put(r);
  for (const c of d.changed) await t.put(c.before);
}

// ---- the single undoable entry ---------------------------------------------

let last: { id: string; run: () => Promise<void> } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
let seq = 0;

export function subscribeUndo(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerUndo(run: () => Promise<void>): string {
  const id = `undo-${Date.now().toString(36)}-${(seq += 1)}`;
  last = { id, run };
  notify();
  return id;
}

export const canUndo = (id: string | null) => Boolean(id && last?.id === id);

export async function runUndo(id: string): Promise<boolean> {
  if (!last || last.id !== id) return false;
  const entry = last;
  last = null;
  notify();
  await entry.run();
  emitDataChange("scheduled_blocks");
  emitDataChange("fixed_commitments");
  return true;
}

// ---- per-turn capture ------------------------------------------------------

type Snap = { blocks: ScheduledBlockRow[]; commitments: FixedCommitmentRow[] };
let capturing = false;
let before: Snap | null = null;
let store: UndoStore = dbUndoStore;

const snap = async (): Promise<Snap> => ({ blocks: await store.blocks.list(), commitments: await store.commitments.list() });

export function beginCapture(s: UndoStore = dbUndoStore) {
  capturing = true;
  before = null;
  store = s;
}

/** Called by runTool before any calendar-changing tool. */
export async function snapshotIfCapturing(): Promise<void> {
  if (capturing && !before) before = await snap().catch(() => null);
}

/** Ends the turn's capture: the receipt line + undo id, or null if nothing changed. */
export async function endCapture(): Promise<{ text: string; undoId: string } | null> {
  capturing = false;
  const b = before;
  before = null;
  if (!b) return null;
  const a = await snap().catch(() => null);
  if (!a) return null;
  const blocks = diffRows(b.blocks, a.blocks);
  const commitments = diffRows(b.commitments, a.commitments);
  if (empty(blocks) && empty(commitments)) return null;
  const s = store;
  const undoId = registerUndo(async () => {
    await restore(s.blocks, blocks);
    await restore(s.commitments, commitments);
  });
  return { text: describeChanges(blocks, commitments), undoId };
}
