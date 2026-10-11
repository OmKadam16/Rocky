/**
 * Memory questions from the phone, answered on the laptop.
 *
 * Unified Memory lives only on the laptop (electron/memory*.cjs). The phone
 * never gets a copy: it sends the question through the existing `commands`
 * relay as one transient row, the laptop answers locally (memory bridge: local
 * search + local model) and writes the answer card back onto that same row,
 * and the phone deletes the row the moment it has read it. The laptop also
 * purges any memory row older than 2 minutes, on start and every minute.
 *
 * Nothing from a memory answer is written anywhere else: not profile extra,
 * not chat memory, not the planner (the turns are private), not logs, not the
 * phone's saved history.
 *
 *   phone  -> row  text "rocky-memory:v1"  diff { question }      status queued
 *   laptop -> same row  status done + reply_text <card JSON>     | status error + error <code>
 *
 * Pure over a small store port (RelayStore) so the protocol is tested with a
 * fake Supabase (memoryRelay.test.ts).
 */
import type { ChatCard, MemorySource } from "../types";

export const MEMORY_REQUEST_MARK = "rocky-memory:v1";
/** The phone gives up after this long. */
export const MEMORY_TIMEOUT_MS = 30_000;
/** Any memory row older than this is deleted by the laptop. */
export const MEMORY_ROW_TTL_MS = 2 * 60_000;
/** A request this old when the laptop sees it is dropped, not answered. */
const STALE_REQUEST_MS = 60_000;
const POLL_MS = 400;

/** The note shown once, under the first relayed card. True to the transient-row rule. */
export const RELAY_NOTE = "Sent through your account for a moment, then deleted.";

export const MESSAGES = {
  asleep: "Your laptop is asleep or closed. Wake it and open Rocky.",
  phoneOff: "Memory questions from your phone are turned off in Rocky on your laptop.",
  timeout: "Your laptop didn't answer within 30 seconds. Try again in a moment.",
  noLaptopApp: "Memory answers come from Rocky on your laptop. Open the desktop app there and try again.",
  failed: "Couldn't reach your laptop for that. Try again in a moment.",
} as const;

export type MemoryCard = Extract<ChatCard, { kind: "memory" }>;

export type RelayRow = { id: string; status: string; reply_text: string | null; error: string | null; created_at: string; diff?: unknown };

export interface RelayStore {
  insertRequest(question: string): Promise<string | null>;
  readRow(id: string): Promise<RelayRow | null>;
  answer(id: string, patch: { status: "done" | "error"; reply_text?: string | null; error?: string | null }): Promise<void>;
  deleteRow(id: string): Promise<void>;
  /** Delete every memory row created before `beforeIso`. */
  purgeBefore(beforeIso: string): Promise<void>;
  queued(): Promise<RelayRow[]>;
}

const card = (status: MemoryCard["status"], answer: string, sources: MemorySource[] = []): MemoryCard => ({ kind: "memory", status, answer, sources });

// ---------------------------------------------------------------------------
// Phone side
// ---------------------------------------------------------------------------

export type AskDeps = {
  store: RelayStore;
  /** The laptop's last heartbeat (ms), or null when there's no laptop row. */
  laptopLastSeen: () => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  offlineAfterMs?: number;
};

/** Ask the laptop. Always resolves with a card; never a made-up answer. */
export async function askMemoryOnLaptop(question: string, deps: AskDeps): Promise<MemoryCard> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const seen = await deps.laptopLastSeen().catch(() => null);
  if (seen == null || now() - seen > (deps.offlineAfterMs ?? 45_000)) return card("unavailable", MESSAGES.asleep);

  const id = await deps.store.insertRequest(question.slice(0, 500)).catch(() => null);
  if (!id) return card("unavailable", MESSAGES.failed);
  const deadline = now() + (deps.timeoutMs ?? MEMORY_TIMEOUT_MS);
  try {
    while (now() < deadline) {
      await sleep(POLL_MS);
      const row = await deps.store.readRow(id).catch(() => null);
      if (!row || row.status === "queued") continue;
      if (row.status === "error") return card("off", row.error === "phone_off" ? MESSAGES.phoneOff : MESSAGES.failed);
      if (row.status === "done") return parseCard(row.reply_text) ?? card("unavailable", MESSAGES.failed);
    }
    return card("unavailable", MESSAGES.timeout);
  } finally {
    // Delete-after-read (or after giving up): the row never outlives the question.
    await deps.store.deleteRow(id).catch(() => {});
  }
}

/** Only a well-formed card gets through; anything else is dropped. */
export function parseCard(text: string | null): MemoryCard | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<MemoryCard>;
    const status = v.status;
    if (status !== "answered" && status !== "none" && status !== "off" && status !== "unavailable") return null;
    if (typeof v.answer !== "string") return null;
    const sources = Array.isArray(v.sources)
      ? v.sources
          .filter((s): s is MemorySource => Boolean(s && typeof s.url === "string" && /^https?:\/\//i.test(s.url)))
          .slice(0, 6)
          .map((s) => ({ title: String(s.title ?? "").slice(0, 200), url: s.url, domain: String(s.domain ?? "").slice(0, 100), capturedAt: String(s.capturedAt ?? "") }))
      : [];
    return card(status, v.answer.slice(0, 1200), sources);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Laptop side
// ---------------------------------------------------------------------------

export type HostDeps = {
  store: RelayStore;
  /** The local Memory path (memory bridge: local search + local model). */
  ask: (question: string) => Promise<MemoryCard>;
  /** "Allow Memory questions from my phone". */
  allowed: () => boolean | Promise<boolean>;
  now?: () => number;
};

export async function handleMemoryRequest(row: RelayRow, deps: HostDeps): Promise<"answered" | "refused" | "stale" | "skipped"> {
  if (row.status !== "queued") return "skipped";
  const now = deps.now ?? (() => Date.now());
  if (now() - new Date(row.created_at).getTime() > STALE_REQUEST_MS) {
    await deps.store.deleteRow(row.id).catch(() => {});
    return "stale";
  }
  if (!(await deps.allowed())) {
    await deps.store.answer(row.id, { status: "error", error: "phone_off" });
    return "refused";
  }
  const q = (row.diff as { question?: unknown } | null)?.question;
  const question = typeof q === "string" ? q.trim().slice(0, 500) : "";
  if (!question) {
    await deps.store.answer(row.id, { status: "error", error: "bad_request" });
    return "refused";
  }
  const answer = await deps.ask(question).catch(() => card("unavailable", "Memory didn't answer. Try again in a moment."));
  await deps.store.answer(row.id, { status: "done", reply_text: JSON.stringify({ status: answer.status, answer: answer.answer, sources: answer.sources }) });
  return "answered";
}

/** Laptop timer + startup: memory rows never outlive 2 minutes. */
export async function purgeMemoryRows(store: RelayStore, now: number = Date.now()): Promise<void> {
  await store.purgeBefore(new Date(now - MEMORY_ROW_TTL_MS).toISOString()).catch(() => {});
}
