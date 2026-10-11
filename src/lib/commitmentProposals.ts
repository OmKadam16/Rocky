/**
 * Fixed commitments by chat: propose → confirm.
 *
 * The planner can only PROPOSE (propose_commitment / _change / _removal).
 * A proposal lives here in memory and is rendered as a CommitmentCard. Only
 * confirmProposal writes to fixed_commitments, and it is reached from the
 * card's Confirm button or the user's own spoken yes (code fast path in
 * useAssistant), never from a model tool. Confirming is idempotent: a double
 * click or a yes + click writes once.
 */
import type { FixedCommitmentRow } from "../../shared/db";
import type { CommitmentFields } from "../types";
import { db } from "./db";
import { emitDataChange } from "./supaDb";

export type ProposalOp = "add" | "update" | "delete";
export type ProposalStatus = "pending" | "confirmed" | "cancelled" | "replaced";

export type Proposal = {
  id: string;
  op: ProposalOp;
  fields: CommitmentFields;
  /** The commitment being changed or removed. */
  targetId: string | null;
  /** Its row before the change, for undo. */
  before: FixedCommitmentRow | null;
  status: ProposalStatus;
  conflicts: string[];
  /** The id written on confirm (add). */
  writtenId: string | null;
};

/** Where commitments live. Injected so tests never touch a database. */
export type CommitmentStore = {
  list: () => Promise<FixedCommitmentRow[]>;
  put: (row: FixedCommitmentRow) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

export const dbCommitmentStore: CommitmentStore = {
  list: () => db.fixed_commitments.toArray(),
  put: async (row) => {
    await db.fixed_commitments.put(row);
    emitDataChange("fixed_commitments");
  },
  remove: async (id) => {
    await db.fixed_commitments.delete(id);
    emitDataChange("fixed_commitments");
  },
};

const proposals = new Map<string, Proposal>();
const inflight = new Map<string, Promise<ConfirmResult>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function subscribeProposals(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getProposal = (id: string) => proposals.get(id) ?? null;
export function resetProposals() {
  proposals.clear();
  inflight.clear();
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ---------------------------------------------------------------------------
// Fields: parsing, validation, the one next question, conflicts, summary
// ---------------------------------------------------------------------------

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPES = new Set(["Class", "Work", "Gym", "Other"]);
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
export const pad = (t: string) => {
  const m = HHMM.exec(t.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : t;
};

/** Days from the planner: [1,2], "1,2", ["Mon","Tue"]. Invalid entries are dropped. */
export function parseDays(input: unknown): number[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,\s]+/) : [];
  const out = new Set<number>();
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) out.add(v);
    else if (typeof v === "string") {
      const n = Number(v);
      if (v.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
      else {
        const i = DAY_SHORT.findIndex((d) => v.trim().toLowerCase().startsWith(d.toLowerCase()));
        if (i >= 0) out.add(i);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

export type PartialFields = Partial<CommitmentFields>;

export function normalizeFields(args: Record<string, unknown>): PartialFields {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const out: PartialFields = {};
  if (str(args.name)) out.name = str(args.name)!.slice(0, 80);
  if (str(args.type)) out.type = (TYPES.has(str(args.type)!) ? str(args.type) : "Other") as CommitmentFields["type"];
  if (args.days_of_week != null) {
    const d = parseDays(args.days_of_week);
    if (d.length) out.days_of_week = d;
  }
  if (str(args.start_time)) out.start_time = pad(str(args.start_time)!);
  if (str(args.end_time)) out.end_time = pad(str(args.end_time)!);
  if (args.active_from !== undefined) out.active_from = str(args.active_from) ?? null;
  if (args.active_until !== undefined) out.active_until = str(args.active_until) ?? null;
  if (args.notes !== undefined) out.notes = str(args.notes) ?? null;
  return out;
}

const QUESTIONS = {
  name: "What should I call it?",
  days: "Which days of the week?",
  start: "What time does it start?",
  end: "And what time does it end?",
} as const;

/**
 * What's still missing, asked one at a time: name, days, start, end.
 * Times are never invented; a bad value is asked again, not guessed.
 */
export function nextMissing(f: PartialFields): { field: keyof typeof QUESTIONS; question: string } | { error: string } | null {
  if (!f.name) return { field: "name", question: QUESTIONS.name };
  if (!f.days_of_week?.length) return { field: "days", question: QUESTIONS.days };
  if (!f.start_time) return { field: "start", question: QUESTIONS.start };
  if (!HHMM.test(f.start_time)) return { error: "start_time must be HH:MM (24h). Ask the user for the start time." };
  if (!f.end_time) return { field: "end", question: QUESTIONS.end };
  if (!HHMM.test(f.end_time)) return { error: "end_time must be HH:MM (24h). Ask the user for the end time." };
  if (toMin(f.end_time) <= toMin(f.start_time)) return { error: "end_time must be after start_time. Ask the user which end time they meant." };
  if (f.active_from && !ISO.test(f.active_from)) return { error: "active_from must be YYYY-MM-DD." };
  if (f.active_until && !ISO.test(f.active_until)) return { error: "active_until must be YYYY-MM-DD." };
  if (f.active_from && f.active_until && f.active_until < f.active_from) return { error: "active_until is before active_from." };
  return null;
}

export function complete(f: PartialFields): CommitmentFields {
  return {
    name: f.name ?? "",
    type: f.type ?? "Other",
    days_of_week: f.days_of_week ?? [],
    start_time: f.start_time ?? "",
    end_time: f.end_time ?? "",
    active_from: f.active_from ?? null,
    active_until: f.active_until ?? null,
    notes: f.notes ?? null,
  };
}

const rangesOverlap = (a: CommitmentFields | FixedCommitmentRow, b: CommitmentFields | FixedCommitmentRow) => {
  const af = a.active_from ?? "0000-01-01";
  const au = a.active_until ?? "9999-12-31";
  const bf = b.active_from ?? "0000-01-01";
  const bu = b.active_until ?? "9999-12-31";
  return af <= bu && bf <= au;
};

/** Plain-language clashes with existing commitments (shared weekday, overlapping hours and dates). */
export function conflictsFor(f: CommitmentFields, existing: FixedCommitmentRow[], ignoreId: string | null = null): string[] {
  const out: string[] = [];
  for (const c of existing) {
    if (c.id === ignoreId) continue;
    const shared = c.days_of_week.filter((d) => f.days_of_week.includes(d));
    if (!shared.length) continue;
    const cs = toMin(c.start_time.slice(0, 5));
    const ce = toMin(c.end_time.slice(0, 5));
    if (!(toMin(f.start_time) < ce && cs < toMin(f.end_time))) continue;
    if (!rangesOverlap(f, c)) continue;
    out.push(`Overlaps ${c.name} on ${shared.map((d) => DAY_SHORT[d]).join(", ")} ${c.start_time.slice(0, 5)}–${c.end_time.slice(0, 5)}`);
  }
  return out;
}

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** "Chem 101 · Mon, Tue · 10:00–11:30 · starts Oct 12" */
export function summarize(f: CommitmentFields): string {
  const parts = [f.name, f.days_of_week.map((d) => DAY_SHORT[d]).join(", "), `${f.start_time}–${f.end_time}`];
  if (f.active_from) parts.push(`starts ${shortDate(f.active_from)}`);
  if (f.active_until) parts.push(`until ${shortDate(f.active_until)}`);
  return parts.join(" · ");
}

export function fieldsFromRow(r: FixedCommitmentRow): CommitmentFields {
  return {
    name: r.name,
    type: (TYPES.has(r.type) ? r.type : "Other") as CommitmentFields["type"],
    days_of_week: [...r.days_of_week].sort((a, b) => a - b),
    start_time: r.start_time.slice(0, 5),
    end_time: r.end_time.slice(0, 5),
    active_from: r.active_from ?? null,
    active_until: r.active_until ?? null,
    notes: r.notes ?? null,
  };
}

function rowFrom(id: string, f: CommitmentFields, prev: FixedCommitmentRow | null): FixedCommitmentRow {
  return {
    ...(prev ?? {}),
    id,
    name: f.name,
    type: f.type,
    days_of_week: f.days_of_week,
    start_time: f.start_time,
    end_time: f.end_time,
    active_from: f.active_from,
    active_until: f.active_until,
    notes: f.notes,
  } as FixedCommitmentRow;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Create a pending proposal. Writes nothing. Any older pending one is replaced. */
export async function createProposal(
  op: ProposalOp,
  fields: CommitmentFields,
  target: FixedCommitmentRow | null,
  store: CommitmentStore = dbCommitmentStore,
): Promise<Proposal> {
  for (const p of proposals.values()) if (p.status === "pending") p.status = "replaced";
  const existing = await store.list();
  const conflicts = op === "delete" ? [] : conflictsFor(fields, existing, target?.id ?? null);
  const p: Proposal = { id: newId(), op, fields, targetId: target?.id ?? null, before: target, status: "pending", conflicts, writtenId: null };
  proposals.set(p.id, p);
  notify();
  return p;
}

/** Inline edit on the card, before confirming. Re-checks conflicts. */
export async function editProposal(id: string, patch: PartialFields, store: CommitmentStore = dbCommitmentStore): Promise<{ ok: boolean; error?: string }> {
  const p = proposals.get(id);
  if (!p || p.status !== "pending" || p.op === "delete") return { ok: false, error: "This proposal can't be edited any more." };
  const next = { ...p.fields, ...patch };
  const bad = nextMissing(next);
  if (bad) return { ok: false, error: "error" in bad ? bad.error.replace(/ Ask.*$/, "") : `Missing: ${bad.field}` };
  p.fields = complete(next);
  p.conflicts = conflictsFor(p.fields, await store.list(), p.targetId);
  notify();
  return { ok: true };
}

export function cancelProposal(id: string): boolean {
  const p = proposals.get(id);
  if (!p || p.status !== "pending") return false;
  p.status = "cancelled";
  notify();
  return true;
}

export type ConfirmResult = { ok: boolean; already?: boolean; error?: string; proposal?: Proposal; undo?: () => Promise<void> };

/** The only path that writes a commitment. Idempotent per proposal. */
export function confirmProposal(id: string, store: CommitmentStore = dbCommitmentStore): Promise<ConfirmResult> {
  const p = proposals.get(id);
  if (!p) return Promise.resolve({ ok: false, error: "That proposal has expired. Ask again." });
  if (p.status === "confirmed") return Promise.resolve({ ok: true, already: true, proposal: p });
  if (p.status !== "pending") return Promise.resolve({ ok: false, error: "That proposal was cancelled." });
  const running = inflight.get(id);
  if (running) return running;
  const job = (async (): Promise<ConfirmResult> => {
    try {
      let undo: () => Promise<void>;
      if (p.op === "add") {
        const rowId = newId();
        await store.put(rowFrom(rowId, p.fields, null));
        p.writtenId = rowId;
        undo = () => store.remove(rowId);
      } else if (p.op === "update") {
        if (!p.targetId || !p.before) return { ok: false, error: "That commitment no longer exists." };
        const before = p.before;
        await store.put(rowFrom(p.targetId, p.fields, before));
        undo = () => store.put(before);
      } else {
        if (!p.targetId || !p.before) return { ok: false, error: "That commitment no longer exists." };
        const before = p.before;
        await store.remove(p.targetId);
        undo = () => store.put(before);
      }
      p.status = "confirmed";
      notify();
      return { ok: true, proposal: p, undo };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, job);
  return job;
}

/** Find the commitment the user means. One match, or a question. */
export function findCommitment(query: string, rows: FixedCommitmentRow[]): { row: FixedCommitmentRow } | { question: string } {
  const q = query.trim().toLowerCase();
  if (!q) return { question: "Which commitment?" };
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  if (exact.length === 1) return { row: exact[0] };
  const words = q.split(/\s+/);
  const fuzzy = rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
  if (fuzzy.length === 1) return { row: fuzzy[0] };
  if (!fuzzy.length) return { question: `I can't find a commitment called "${query}". Which one do you mean?` };
  return { question: `Which one: ${fuzzy.map((r) => r.name).join(", ")}?` };
}

// ---------------------------------------------------------------------------
// Spoken yes / no, checked in code against the latest card
// ---------------------------------------------------------------------------

const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|commit( it)?|add it|save it|do it|go ahead|looks good|that'?s right|correct)\b[\s.!,]*(please|thanks)?[\s.!]*$/i;
const NO = /^\s*(no|nope|nah|cancel( it)?|don'?t|never ?mind|scrap (it|that)|forget it)\b/i;

/**
 * A spoken/typed reply to the commitment card on screen. Only acts when the
 * latest assistant card is a still-pending proposal; anything else (or any
 * other wording) goes to the planner.
 */
export function commitmentReply(text: string, pendingId: string | null): { action: "confirm" | "cancel"; id: string } | null {
  if (!pendingId) return null;
  const p = proposals.get(pendingId);
  if (!p || p.status !== "pending") return null;
  if (YES.test(text)) return { action: "confirm", id: pendingId };
  if (NO.test(text)) return { action: "cancel", id: pendingId };
  return null;
}

export function receiptText(p: Proposal): string {
  if (p.op === "add") return `Added ${p.fields.name} to your fixed commitments · ${summarize(p.fields).replace(`${p.fields.name} · `, "")}`;
  if (p.op === "update") return `Updated ${p.fields.name} · ${summarize(p.fields).replace(`${p.fields.name} · `, "")}`;
  return `Removed ${p.fields.name} from your fixed commitments`;
}
