/**
 * Phone ⇄ laptop relay for the booking agent, over the existing `commands`
 * table (RLS "own rows only", already in the realtime publication). No
 * migration: rows are marked by `text` and carry their payload in `diff`.
 *
 *   phone  → laptop  text "rocky-agent:v1"        diff { op, task?, text?, yes? }  status queued → done (+ reply_text)
 *   laptop → phone   text "rocky-agent-event:v1"  diff <sanitized agent event>
 *
 * What may go through Supabase: short status and question text, the plan
 * summary, the booking reference, and (in a start request) the booking's own
 * contact details. Never screenshots, page text, the step log or URLs.
 * Relay rows are deleted shortly after use.
 */
import { supabase, uniqueChannel } from "./supabase";
import { applyAgentEvent, setRelayBackend, startAgent, prepareAgent, answerAgent, confirmAgent, continueAgent, cancelAgent, tapAgentEvents, type AgentBackend, type AgentEvent } from "./agentClient";
import type { AgentTask } from "./bookingTask";
import { LAPTOP_ASLEEP_MESSAGE, readLaptopLastSeen, statusFromLastSeen } from "./devices";

export const REQUEST_MARK = "rocky-agent:v1";
export const EVENT_MARK = "rocky-agent-event:v1";
const RELAY_TIMEOUT_MS = 12_000;
const RETENTION_MS = 2 * 60_000;

export type RelayOp =
  | { op: "start"; task: AgentTask }
  | { op: "prepare"; task: AgentTask }
  | { op: "answer"; text: string }
  | { op: "confirm"; yes: boolean }
  | { op: "continue" }
  | { op: "cancel" }
  /** Connection check: the laptop answers at once, nothing else happens. */
  | { op: "ping" }
  /** Connection check: the phone tells the laptop how long the last ping took. */
  | { op: "report"; ms: number; phone: string };

const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

/** Strip an agent event down to what may leave the laptop. Null = don't relay. */
export function sanitizeForRelay(e: AgentEvent): AgentEvent | null {
  switch (e.type) {
    case "step":
      return null; // the step log stays on the laptop
    case "status":
      return { type: "status", state: e.state, text: clip(e.text, 80) };
    case "progress":
      return { type: "progress", text: clip(e.text, 80) };
    case "question":
      return { type: "question", question: clip(e.question, 300), field: clip(e.field, 60) };
    case "code_request":
      // Only where it was sent. The code itself never touches the relay.
      return { type: "code_request", channel: e.channel === "email" ? "email" : "sms", attempt: Math.max(0, Math.min(9, Number(e.attempt) || 0)) };
    case "needs_confirmation":
      return { type: "needs_confirmation", kind: e.kind, summary: clip(e.summary, 400), screenshot: null };
    case "needs_user_takeover":
      return { type: "needs_user_takeover", reason: e.reason, message: clip(e.message, 300) };
    case "done":
      return { type: "done", status: e.status, reference: e.reference ? clip(e.reference, 80) : null, confirmationText: "", url: "", screenshot: null, holdBlockId: e.holdBlockId };
    case "failed":
      return { type: "failed", reason: clip(e.reason, 200), holdBlockId: e.holdBlockId };
    case "cancelled":
      return { type: "cancelled", message: clip(e.message, 200), holdBlockId: e.holdBlockId };
    default:
      return null;
  }
}

/** Validate a phone request row's payload. Anything odd is ignored. */
export function parseRequest(diff: unknown): RelayOp | null {
  const d = diff && typeof diff === "object" ? (diff as Record<string, unknown>) : null;
  if (!d) return null;
  switch (d.op) {
    case "start":
      return d.task && typeof d.task === "object" ? { op: "start", task: d.task as AgentTask } : null;
    case "prepare":
      return d.task && typeof d.task === "object" ? { op: "prepare", task: d.task as AgentTask } : null;
    case "answer":
      return typeof d.text === "string" && d.text.trim() ? { op: "answer", text: d.text.slice(0, 500) } : null;
    case "confirm":
      return { op: "confirm", yes: d.yes === true };
    case "continue":
      return { op: "continue" };
    case "cancel":
      return { op: "cancel" };
    case "ping":
      return { op: "ping" };
    case "report":
      return typeof d.ms === "number" && Number.isFinite(d.ms) ? { op: "report", ms: Math.max(0, Math.round(d.ms)), phone: clip(d.phone, 40) } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Last phone ping, shown on the laptop's Devices section.
// ---------------------------------------------------------------------------

export type PhonePing = { at: number; ms: number; phone: string };
let lastPhonePing: PhonePing | null = null;
const pingListeners = new Set<(p: PhonePing) => void>();
export const getLastPhonePing = () => lastPhonePing;
export function onPhonePing(fn: (p: PhonePing) => void): () => void {
  pingListeners.add(fn);
  return () => void pingListeners.delete(fn);
}
function recordPhonePing(p: PhonePing) {
  lastPhonePing = p;
  pingListeners.forEach((fn) => fn(p));
}

type Row = { id: string; source: string; text: string | null; status: string; diff: unknown; reply_text: string | null; created_at: string };

async function cleanup(olderThanMs: number) {
  try {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    await supabase().from("commands").delete().in("text", [REQUEST_MARK, EVENT_MARK]).lt("created_at", cutoff);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Laptop: run requests from the phone, publish events back.
// ---------------------------------------------------------------------------

async function runRequest(op: RelayOp): Promise<{ ok: boolean; error?: string }> {
  switch (op.op) {
    case "start":
      return startAgent(op.task, "phone");
    case "prepare":
      prepareAgent(op.task);
      return { ok: true };
    case "answer":
      return { ok: await answerAgent(op.text) };
    case "confirm":
      return { ok: await confirmAgent(op.yes) };
    case "continue":
      return { ok: await continueAgent() };
    case "cancel":
      return { ok: await cancelAgent() };
    case "ping":
      return { ok: true };
    case "report":
      recordPhonePing({ at: Date.now(), ms: op.ms, phone: op.phone });
      return { ok: true };
  }
}

export function startAgentRelayHost(): () => void {
  const sb = supabase();
  const seen = new Set<string>();
  const handle = async (row: Row) => {
    if (row.source !== "phone" || row.text !== REQUEST_MARK || row.status !== "queued" || seen.has(row.id)) return;
    seen.add(row.id);
    // Stale requests (laptop was closed) are dropped, never replayed later.
    if (Date.now() - new Date(row.created_at).getTime() > 60_000) {
      await sb.from("commands").update({ status: "error", error: "expired" }).eq("id", row.id);
      return;
    }
    const op = parseRequest(row.diff);
    const result = op ? await runRequest(op).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "bad request" };
    // A report needs no answer: its row goes right away.
    if (op?.op === "report") await sb.from("commands").delete().eq("id", row.id);
    else await sb.from("commands").update({ status: "done", reply_text: JSON.stringify(result) }).eq("id", row.id);
  };
  const channel = sb
    .channel(uniqueChannel("rocky-agent-host"))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "commands", filter: "source=eq.phone" }, (p) => void handle(p.new as Row))
    .subscribe();
  // Anything queued in the last minute while we weren't listening.
  void (async () => {
    await cleanup(60 * 60_000);
    const { data } = await sb.from("commands").select("*").eq("source", "phone").eq("text", REQUEST_MARK).eq("status", "queued");
    for (const r of (data as Row[] | null) ?? []) await handle(r);
  })().catch(() => {});

  let cleanupTimer: number | undefined;
  const untap = tapAgentEvents((e) => {
    const safe = sanitizeForRelay(e);
    if (!safe) return;
    void sb.from("commands").insert({ source: "laptop", kind: "text", text: EVENT_MARK, status: "done", diff: safe as unknown as Record<string, unknown> });
    if (e.type === "done" || e.type === "failed" || e.type === "cancelled") {
      window.clearTimeout(cleanupTimer);
      cleanupTimer = window.setTimeout(() => void cleanup(RETENTION_MS), RETENTION_MS + 5_000);
    }
  });
  return () => {
    untap();
    window.clearTimeout(cleanupTimer);
    void sb.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Phone: a relay backend for agentClient, and the laptop's events.
// ---------------------------------------------------------------------------

async function send(op: RelayOp, timeoutMs = RELAY_TIMEOUT_MS, pollMs = 700): Promise<{ ok: boolean; error?: string }> {
  const sb = supabase();
  const { data, error } = await sb.from("commands").insert({ source: "phone", kind: "text", text: REQUEST_MARK, status: "queued", diff: op as unknown as Record<string, unknown> }).select("id").single();
  if (error || !data) return { ok: false, error: "Couldn't reach your laptop." };
  const id = (data as { id: string }).id;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const { data: row } = await sb.from("commands").select("status, reply_text").eq("id", id).maybeSingle();
      const r = row as { status: string; reply_text: string | null } | null;
      if (r && r.status === "done") {
        try {
          return JSON.parse(r.reply_text ?? "{}");
        } catch {
          return { ok: false };
        }
      }
      if (r && r.status === "error") return { ok: false, error: "Your laptop didn't take that." };
    }
    const presence = await readLaptopLastSeen().catch(() => null);
    if (statusFromLastSeen(presence?.lastSeenMs ?? null) === "offline") return { ok: false, error: LAPTOP_ASLEEP_MESSAGE };
    return { ok: false, error: "Your laptop isn't answering. Open Rocky on the laptop (the desktop app) and try again." };
  } finally {
    // The phone's own rows go as soon as they're answered (or time out).
    void sb.from("commands").delete().eq("id", id);
  }
}

/**
 * Connection check (phone): a harmless ping through the commands relay,
 * timed until the laptop marks it done. The time is then reported to the
 * laptop (fire and forget) for its Devices section.
 */
export async function pingLaptop(phoneName: string, timeoutMs = 8000): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const t0 = performance.now();
  const r = await send({ op: "ping" }, timeoutMs, 150);
  if (!r.ok) return { ok: false, error: r.error ?? "No answer from the laptop." };
  const ms = Math.round(performance.now() - t0);
  void supabase()
    .from("commands")
    .insert({ source: "phone", kind: "text", text: REQUEST_MARK, status: "queued", diff: { op: "report", ms, phone: phoneName.slice(0, 40) } })
    .then(() => {}, () => {});
  return { ok: true, ms };
}

export function startAgentRelayClient(): () => void {
  const sb = supabase();
  const backend: AgentBackend = {
    kind: "relay",
    start: (task) => send({ op: "start", task }),
    prepare: (task) => send({ op: "prepare", task }),
    answer: async (text) => (await send({ op: "answer", text })).ok,
    confirm: async (yes) => (await send({ op: "confirm", yes })).ok,
    continue: async () => (await send({ op: "continue" })).ok,
    cancel: async () => (await send({ op: "cancel" })).ok,
  };
  setRelayBackend(backend);
  const onRow = (row: Row) => {
    if (row.source !== "laptop" || row.text !== EVENT_MARK) return;
    const e = sanitizeForRelay(row.diff as AgentEvent); // re-sanitize: never trust the wire
    if (e) applyAgentEvent(e, true);
  };
  const channel = sb
    .channel(uniqueChannel("rocky-agent-client"))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "commands", filter: "source=eq.laptop" }, (p) => onRow(p.new as Row))
    .subscribe();
  // Pick up a run still in progress (quietly: nothing is re-spoken). A run
  // that already ended isn't replayed.
  void (async () => {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data } = await sb.from("commands").select("*").eq("source", "laptop").eq("text", EVENT_MARK).gte("created_at", since).order("created_at", { ascending: true }).limit(30);
    const rows = (data as Row[] | null) ?? [];
    const last = rows.length ? (rows[rows.length - 1].diff as AgentEvent | null) : null;
    if (!last || ["done", "failed", "cancelled"].includes(last.type)) return;
    for (const r of rows) {
      const e = sanitizeForRelay(r.diff as AgentEvent);
      if (e) applyAgentEvent(e, true, true);
    }
  })().catch(() => {});
  return () => {
    setRelayBackend(null);
    void sb.removeChannel(channel);
  };
}
