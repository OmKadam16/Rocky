/**
 * Chat memory: what Rocky keeps from conversations after the chat itself is
 * cleared or scrolls out of the planner's window (it only sees the last few
 * turns). Two parts:
 *   - facts: short lasting things the user wants kept ("I'm vegetarian",
 *     "my barber is Fade Co"), saved by the planner's remember_fact tool and
 *     removed by forget_fact or the Memory list in the chat header;
 *   - summary: a running summary of earlier conversation, folded in as turns
 *     leave the planner's window and when the chat is cleared.
 * The planner reads both at the top of every turn (plannerLocal.ts).
 *
 * Synced between the user's devices through the profile row's `extra`
 * (`chat_memory`; RLS "own rows only"; no migration), so the phone and laptop
 * share one memory. Built only from planner-visible turns: never Memory
 * (browsing) answers, codes, passwords, card or ID numbers.
 */
import Dexie, { type Table } from "dexie";
import type { AssistantTurn } from "../types";

export type ChatFact = { id: string; text: string; at: number };
export type ChatMemory = { facts: ChatFact[]; summary: string; summarizedUpTo: number };

export const MAX_FACTS = 60;
export const MAX_FACT_LEN = 200;
export const MAX_SUMMARY = 1500;
/** Fold turns into the summary once this many have left the planner's window. */
export const FOLD_AFTER = 6;
/** The planner sees this many recent turns (plannerLocal.plannerHistory). */
export const PLANNER_WINDOW = 8;

/** Never kept in memory, whatever the planner or the user says. */
const SECRET =
  /\b(passw|passcode|pin\b|otp|one[- ]time|verification code|2fa|cvv|cvc|security code|card number|credit card|debit card|iban|routing|account number|ssn|social security|passport)|(?:\d[ -]?){12,}|•••• \(verification code\)/i;

export const isSecret = (text: string) => SECRET.test(text);

// ---------------------------------------------------------------------------
// Storage (Dexie on the device; tests swap in an in-memory store)
// ---------------------------------------------------------------------------

export type MemoryStore = {
  facts: () => Promise<ChatFact[]>;
  putFact: (f: ChatFact) => Promise<void>;
  deleteFacts: (ids: string[]) => Promise<void>;
  getMeta: (key: string) => Promise<string | null>;
  setMeta: (key: string, value: string) => Promise<void>;
  clear: () => Promise<void>;
};

class MemoryDB extends Dexie {
  facts!: Table<ChatFact, string>;
  meta!: Table<{ key: string; value: string }, string>;
  constructor() {
    super("RockyChatMemory");
    this.version(1).stores({ facts: "id, at", meta: "key" });
  }
}

function dexieStore(): MemoryStore {
  let db: MemoryDB | null = null;
  const d = () => (db ??= new MemoryDB());
  return {
    facts: () => d().facts.orderBy("at").toArray(),
    putFact: async (f) => void (await d().facts.put(f)),
    deleteFacts: (ids) => d().facts.bulkDelete(ids),
    getMeta: async (key) => (await d().meta.get(key))?.value ?? null,
    setMeta: async (key, value) => void (await d().meta.put({ key, value })),
    clear: async () => {
      await d().facts.clear();
      await d().meta.clear();
    },
  };
}

export function memoryStoreInMemory(): MemoryStore {
  const facts = new Map<string, ChatFact>();
  const meta = new Map<string, string>();
  return {
    facts: async () => [...facts.values()].sort((a, b) => a.at - b.at),
    putFact: async (f) => void facts.set(f.id, f),
    deleteFacts: async (ids) => ids.forEach((id) => facts.delete(id)),
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => void meta.set(k, v),
    clear: async () => {
      facts.clear();
      meta.clear();
    },
  };
}


// ---------------------------------------------------------------------------
// Synced store: the profile row's `extra.chat_memory` (laptop + phone share
// it; RLS "own rows only"; no migration). Only the folding bookkeeping
// (which of THIS device's turns are summarised) stays on the device.
// ---------------------------------------------------------------------------

export type SyncedMemory = { v: 1; facts: ChatFact[]; summary: string; updatedAt: number };

export type ProfileAccess = {
  read: () => Promise<SyncedMemory | null>;
  write: (m: SyncedMemory) => Promise<void>;
  localGet: (key: string) => string | null;
  localSet: (key: string, value: string | null) => void;
};

const EMPTY_SYNCED: SyncedMemory = { v: 1, facts: [], summary: "", updatedAt: 0 };

function asSynced(raw: unknown): SyncedMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SyncedMemory>;
  const facts = Array.isArray(r.facts)
    ? r.facts.filter((f): f is ChatFact => Boolean(f && typeof f.id === "string" && typeof f.text === "string")).map((f) => ({ id: f.id, text: f.text.slice(0, MAX_FACT_LEN), at: Number(f.at) || 0 }))
    : [];
  return { v: 1, facts: facts.slice(-MAX_FACTS), summary: typeof r.summary === "string" ? r.summary.slice(0, MAX_SUMMARY) : "", updatedAt: Number(r.updatedAt) || 0 };
}

/** Facts from both, same topic kept once (the newer wins); summaries joined. */
export function mergeMemory(a: SyncedMemory, b: SyncedMemory): SyncedMemory {
  const facts: ChatFact[] = [];
  for (const f of [...a.facts, ...b.facts].sort((x, y) => x.at - y.at)) {
    const i = facts.findIndex((g) => g.id === f.id || sameTopic(g.text, f.text));
    if (i >= 0) facts.splice(i, 1);
    facts.push(f);
  }
  const summary = [a.summary.trim(), b.summary.trim()].filter(Boolean).filter((x, i, all) => all.indexOf(x) === i).join(" ").slice(0, MAX_SUMMARY);
  return { v: 1, facts: facts.slice(-MAX_FACTS), summary, updatedAt: Math.max(a.updatedAt, b.updatedAt) };
}

const LOCAL_META = new Set(["summarized_up_to"]);

export function profileStore(p: ProfileAccess): MemoryStore {
  const read = async () => (await p.read()) ?? { ...EMPTY_SYNCED };
  // Read fresh before every write so the other device's changes are kept.
  const change = async (fn: (m: SyncedMemory) => SyncedMemory) => {
    const next = fn(await read());
    await p.write({ ...next, updatedAt: Date.now() });
  };
  return {
    facts: async () => [...(await read()).facts].sort((a, b) => a.at - b.at),
    putFact: (f) => change((m) => ({ ...m, facts: [...m.facts.filter((g) => g.id !== f.id), f] })),
    deleteFacts: (ids) => change((m) => ({ ...m, facts: m.facts.filter((f) => !ids.includes(f.id)) })),
    getMeta: async (key) => (LOCAL_META.has(key) ? p.localGet(key) : key === "summary" ? (await read()).summary : null),
    setMeta: async (key, value) => {
      if (LOCAL_META.has(key)) p.localSet(key, value);
      else if (key === "summary") await change((m) => ({ ...m, summary: value.slice(0, MAX_SUMMARY) }));
    },
    clear: async () => {
      await change(() => ({ ...EMPTY_SYNCED }));
      p.localSet("summarized_up_to", null);
    },
  };
}

/** The real profile row (Supabase when signed in, local Dexie when not). */
function realProfileAccess(): ProfileAccess {
  const LS = (k: string) => `rocky-chat-memory:${k}`;
  return {
    read: async () => {
      const { db } = await import("./db");
      const row = (await db.profiles.get("local")) as unknown as { chat_memory?: unknown } | undefined;
      return asSynced(row?.chat_memory);
    },
    write: async (m) => {
      const { db } = await import("./db");
      await db.profiles.update("local", { chat_memory: m } as never);
    },
    localGet: (k) => {
      try {
        return localStorage.getItem(LS(k));
      } catch {
        return null;
      }
    },
    localSet: (k, v) => {
      try {
        if (v == null) localStorage.removeItem(LS(k));
        else localStorage.setItem(LS(k), v);
      } catch {
        /* bookkeeping only: worst case a few turns are summarised twice */
      }
    },
  };
}

/**
 * Once per device: what this device kept locally before memory synced
 * (RockyChatMemory) is merged into the synced copy, then emptied.
 */
async function migrateLocal(target: MemoryStore, p: ProfileAccess): Promise<void> {
  if (p.localGet("migrated") === "1") return;
  try {
    const local = dexieStore();
    const [facts, summary, upTo] = await Promise.all([local.facts(), local.getMeta("summary"), local.getMeta("summarized_up_to")]);
    if (facts.length || summary) {
      const remote = (await p.read()) ?? { ...EMPTY_SYNCED };
      await p.write(mergeMemory(remote, { v: 1, facts, summary: summary ?? "", updatedAt: Date.now() }));
      if (upTo) p.localSet("summarized_up_to", upTo);
      await local.clear();
      changed();
    }
    p.localSet("migrated", "1");
  } catch {
    /* try again next launch */
  }
  void target;
}

let migrating: Promise<void> | null = null;

let store: MemoryStore | null = null;
const s = (): MemoryStore => {
  if (store) return store;
  const access = realProfileAccess();
  const synced = profileStore(access);
  store = synced;
  migrating ??= migrateLocal(synced, access);
  return synced;
};
/** Tests only. */
export function useMemoryStore(next: MemoryStore | null) {
  store = next;
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
export function onMemoryChange(fn: () => void): () => void {
  listeners.add(fn);
  // The other device changed it: the profile row arrives over realtime.
  const remote = () => fn();
  try {
    window.addEventListener("vc-profile-update", remote);
  } catch {
    /* not in a browser */
  }
  return () => {
    listeners.delete(fn);
    try {
      window.removeEventListener("vc-profile-update", remote);
    } catch {
      /* not in a browser */
    }
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function loadMemory(): Promise<ChatMemory> {
  try {
    s();
    if (migrating) await migrating;
    const [facts, summary, upTo] = await Promise.all([s().facts(), s().getMeta("summary"), s().getMeta("summarized_up_to")]);
    return { facts, summary: summary ?? "", summarizedUpTo: Number(upTo) || 0 };
  } catch {
    return { facts: [], summary: "", summarizedUpTo: 0 };
  }
}

/** The system message the planner reads first. Null when there's nothing yet. */
export function memoryContext(m: ChatMemory): string | null {
  if (!m.facts.length && !m.summary.trim()) return null;
  const lines = ["chat_memory — what you remember from earlier chats with this user. Read it before you answer, use it, and never ask for something it already answers. If the user says something different now, their words win."];
  if (m.facts.length) lines.push(`Things they asked you to remember:\n${m.facts.map((f) => `- ${f.text}`).join("\n")}`);
  if (m.summary.trim()) lines.push(`Earlier conversations (summary): ${m.summary.trim()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (t: string) => new Set(norm(t).split(" ").filter((w) => w.length > 2));

/** Overlap of meaningful words: "my barber is Fade Co" ~ "my barber is now Kings Cuts". */
/** "Their barber is Fade Co" -> "their barber". */
const subject = (t: string) => {
  const m = /^(.{3,40}?)\s+(?:is|are|was|were)\s/i.exec(t.trim());
  return m ? norm(m[1]) : null;
};

function sameTopic(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const sa = subject(a);
  if (sa && sa === subject(b)) return true;
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.75;
}

export async function rememberFact(text: string): Promise<{ ok: true; fact: ChatFact; replaced: string | null } | { ok: false; error: string }> {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LEN);
  if (!clean) return { ok: false, error: "Nothing to remember." };
  if (isSecret(clean)) return { ok: false, error: "Never keep passwords, codes, card, bank or ID numbers." };
  const facts = await s().facts();
  const old = facts.find((f) => sameTopic(f.text, clean));
  const fact: ChatFact = { id: old?.id ?? `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, text: clean, at: Date.now() };
  await s().putFact(fact);
  // Oldest go first when full.
  const all = await s().facts();
  if (all.length > MAX_FACTS) await s().deleteFacts(all.slice(0, all.length - MAX_FACTS).map((f) => f.id));
  changed();
  return { ok: true, fact, replaced: old && old.text !== clean ? old.text : null };
}

/** Remove the facts about something ("forget my barber"). Returns what went. */
export async function forgetFacts(about: string): Promise<string[]> {
  const q = norm(about);
  if (!q) return [];
  const qWords = [...words(about)];
  const facts = await s().facts();
  const gone = facts.filter((f) => {
    const t = norm(f.text);
    return t.includes(q) || (qWords.length > 0 && qWords.every((w) => t.includes(w)));
  });
  if (gone.length) {
    await s().deleteFacts(gone.map((f) => f.id));
    changed();
  }
  return gone.map((f) => f.text);
}

export async function removeFact(id: string): Promise<void> {
  await s().deleteFacts([id]);
  changed();
}

export async function forgetEverything(): Promise<void> {
  await s().clear();
  changed();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Turns worth summarising: the planner-visible ones, minus anything secret. */
export function turnsForSummary(turns: AssistantTurn[]): AssistantTurn[] {
  return turns.filter((t) => !t.private && t.text?.trim() && !isSecret(t.text));
}

/**
 * Turns that have left the planner's window and aren't in the summary yet.
 * `all` folds everything not yet summarised (Clear chat).
 */
export function turnsToFold(turns: AssistantTurn[], summarizedUpTo: number, all = false): AssistantTurn[] {
  const visible = turnsForSummary(turns);
  const outOfWindow = all ? visible : visible.slice(0, Math.max(0, visible.length - PLANNER_WINDOW));
  return outOfWindow.filter((t) => (t.at ?? 0) > summarizedUpTo);
}

export function summaryPrompt(prior: string, turns: AssistantTurn[]): { system: string; user: string } {
  return {
    system:
      "You keep the running memory of a user's chats with Rocky, their calendar and booking assistant. Update the memory with the new messages. " +
      "Keep what will matter later: preferences, people and places they mention, decisions, plans in progress, bookings made, failed or pending, things they asked to do later. " +
      "Drop greetings, small talk, and step-by-step back-and-forth. Never include passwords, verification codes, card, bank or ID numbers. " +
      `Write plain sentences in the third person ("They…"), newest facts winning over old ones, at most 150 words. Reply with the memory only.`,
    user: `Current memory:\n${prior.trim() || "(empty)"}\n\nNew messages:\n${turns.map((t) => `${t.role === "user" ? "User" : "Rocky"}: ${t.text.trim()}`).join("\n")}`,
  };
}

let folding: Promise<void> | null = null;

/**
 * Fold turns into the summary with the given model call. Never throws; on a
 * failed call the turns stay unsummarised and are tried again next time.
 */
export async function foldIntoSummary(
  turns: AssistantTurn[],
  complete: (p: { system: string; user: string }) => Promise<string | null>,
  opts: { all?: boolean } = {},
): Promise<void> {
  if (folding) await folding.catch(() => {});
  folding = (async () => {
    const m = await loadMemory();
    const fold = turnsToFold(turns, m.summarizedUpTo, opts.all);
    if (!opts.all && fold.length < FOLD_AFTER) return;
    if (!fold.length) return;
    const next = await complete(summaryPrompt(m.summary, fold)).catch(() => null);
    const text = String(next ?? "").replace(/\s+/g, " ").trim();
    if (!text || isSecret(text)) return;
    await s().setMeta("summary", text.slice(0, MAX_SUMMARY));
    await s().setMeta("summarized_up_to", String(Math.max(...fold.map((t) => t.at ?? 0))));
    changed();
  })();
  try {
    await folding;
  } finally {
    folding = null;
  }
}
