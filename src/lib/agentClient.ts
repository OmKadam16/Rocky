/**
 * Renderer side of Booking Agent v2.
 *
 * The run itself lives in the Electron main process (electron/agentWindow.cjs).
 * This module is the one place the app talks to it:
 *   - a backend: the local desktop bridge (`window.rocky.agent`), or on the
 *     phone a relay through the `commands` table (see agentRelay.ts);
 *   - a small store (`AgentView`) the laptop panel, the phone card, the voice
 *     loop and the planner tools all read;
 *   - laptop-only effects when a run ends: rename or remove the calendar
 *     hold, and save the evidence locally (bookingRecords.ts).
 *
 * The words Rocky speaks for agent events are built here in code, so agent
 * questions reach the user verbatim and "booked" is only ever said when the
 * agent itself reported it with evidence.
 */
import { db } from "./db";
import { emitDataChange } from "./supaDb";
import { finalHoldTitle, type AgentTask } from "./bookingTask";
import { saveBookingRecord } from "./bookingRecords";
import { getSecret } from "./secrets";
import { ProgressTalker } from "./progressTalker";

/** One agent step (one model round trip and what it did), in ms. */
export type AgentStepTiming = { n: number; screenshotMs: number; modelMs: number; actionMs: number; settleMs: number; navMs: number; shotKb: number; totalMs: number };
export type AgentTimingSummary = {
  steps: number;
  totalMs: number;
  avgStepMs: number;
  avgModelMs: number;
  avgScreenshotMs: number;
  avgActionMs: number;
  avgSettleMs: number;
  navMs: number;
  maxStepMs: number;
};

export type AgentEvent =
  | { type: "status"; state: string; text: string; at?: number }
  | { type: "timing"; step: AgentStepTiming; summary: AgentTimingSummary; at?: number }
  /** A code-built reassurance line while the agent works (progressTalker.ts). */
  | { type: "progress"; text: string; at?: number }
  | { type: "step"; n: number; text: string; blocked?: boolean; at?: number }
  | { type: "question"; question: string; field: string; at?: number }
  | { type: "needs_confirmation"; kind: "final" | "safety"; summary: string; screenshot: string | null; at?: number }
  | { type: "needs_user_takeover"; reason: string; message: string; url?: string; at?: number }
  | {
      type: "done";
      status: "booked" | "unclear";
      reference: string | null;
      confirmationText: string;
      refRejected?: boolean;
      url: string;
      screenshot: string | null;
      holdBlockId: string | null;
      task?: { type: string; venue: string; date: string; time: string };
      timing?: AgentTimingSummary;
      at?: number;
    }
  | { type: "failed"; reason: string; url?: string; lastStep?: string; holdBlockId: string | null; timing?: AgentTimingSummary; at?: number }
  | { type: "cancelled"; message: string; holdBlockId: string | null; timing?: AgentTimingSummary; at?: number };

export type AgentPhase = "idle" | "starting" | "running" | "question" | "confirm" | "takeover" | "done" | "failed" | "cancelled";

export type AgentView = {
  phase: AgentPhase;
  /** Short status line: "Opening page", "Filling form", "Waiting for your answer"… */
  status: string;
  question: string | null;
  field: string | null;
  summary: string | null;
  confirmKind: "final" | "safety" | null;
  /** Laptop only: never relayed to the phone. */
  screenshot: string | null;
  message: string | null;
  log: { text: string; blocked: boolean }[];
  result: { status: "booked" | "unclear"; reference: string | null; confirmationText: string } | null;
  /** What Rocky says for the latest event (spoken + shown). Bumps `seq`. */
  announce: string | null;
  seq: number;
  /** True when the run is on another device (the phone watching the laptop). */
  remote: boolean;
  /** Laptop: "phone" when the phone started this run (the phone does the talking). */
  origin: "here" | "phone";
  /** Latest progress line ("Checking availability."). Bumps `progressSeq`. */
  progress: string | null;
  progressSeq: number;
  /** Laptop only, for the hidden debug readout: last step + run averages. */
  timing: { last: AgentStepTiming | null; summary: AgentTimingSummary | null };
};

const IDLE: AgentView = {
  phase: "idle",
  status: "",
  question: null,
  field: null,
  summary: null,
  confirmKind: null,
  screenshot: null,
  message: null,
  log: [],
  result: null,
  announce: null,
  seq: 0,
  remote: false,
  origin: "here",
  progress: null,
  progressSeq: 0,
  timing: { last: null, summary: null },
};

export type AgentBackend = {
  kind: "local" | "relay";
  start: (task: AgentTask) => Promise<{ ok?: boolean; error?: string }>;
  /** Pre-open the start page while the plan is read back (no clicks). */
  prepare?: (task: AgentTask) => Promise<unknown>;
  answer: (text: string) => Promise<boolean>;
  confirm: (yes: boolean) => Promise<boolean>;
  continue: () => Promise<boolean>;
  cancel: () => Promise<boolean>;
};

type DesktopAgentBridge = {
  available: () => Promise<boolean>;
  start: (task: AgentTask) => Promise<{ ok?: boolean; error?: string }>;
  prepare?: (task: AgentTask) => Promise<unknown>;
  answer: (text: string) => Promise<boolean>;
  confirm: (yes: boolean) => Promise<boolean>;
  continue: () => Promise<boolean>;
  cancel: () => Promise<boolean>;
  state: () => Promise<{ active: boolean; state: string; pause: Record<string, string> | null; log: { text: string; blocked: boolean }[] }>;
  onEvent: (handler: (e: AgentEvent) => void) => () => void;
};

const desktop = (): DesktopAgentBridge | null =>
  (typeof window !== "undefined" && (window as unknown as { rocky?: { agent?: DesktopAgentBridge } }).rocky?.agent) || null;

let relay: AgentBackend | null = null;
let view: AgentView = IDLE;
const listeners = new Set<(v: AgentView) => void>();
/** Effects + relay publishers that want every raw event (laptop side). */
const eventTaps = new Set<(e: AgentEvent) => void>();

function set(next: Partial<AgentView>) {
  view = { ...view, ...next };
  for (const l of listeners) l(view);
}

export function getAgentView(): AgentView {
  return view;
}

export function subscribeAgent(fn: (v: AgentView) => void): () => void {
  ensureWired();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Raw events (laptop): used by the phone relay publisher. */
export function tapAgentEvents(fn: (e: AgentEvent) => void): () => void {
  ensureWired();
  eventTaps.add(fn);
  return () => eventTaps.delete(fn);
}

/** The phone installs its relay here when paired with a laptop. */
export function setRelayBackend(b: AgentBackend | null) {
  relay = b;
}

export function backend(): AgentBackend | null {
  const d = desktop();
  if (d) {
    return {
      kind: "local",
      start: async (t) => {
        // A key synced from another device lands in the keychain on first read;
        // the main process reads it from there (and sends it only to OpenAI).
        await getSecret("browser_key").catch(() => null);
        return d.start(t);
      },
      prepare: async (t) => d.prepare?.(t),
      answer: (t) => d.answer(t),
      confirm: (y) => d.confirm(y),
      continue: () => d.continue(),
      cancel: () => d.cancel(),
    };
  }
  return relay;
}

export const agentAvailable = () => backend() != null;
/** True on the desktop app, where the agent window itself lives. */
export const hasLocalAgent = () => desktop() != null;
export const isAgentActive = () => ["starting", "running", "question", "confirm", "takeover"].includes(view.phase);

/** Spoken + shown words for an event. Built in code, never by the planner. */
export function announceFor(e: AgentEvent): string | null {
  switch (e.type) {
    case "question":
      return e.question;
    case "needs_confirmation":
      return e.kind === "final"
        ? `Ready to book: ${e.summary.replace(/[.\s]+$/, "")}. Say yes to book it, or no to stop.`
        : `OpenAI flagged this step: ${e.summary.replace(/[.\s]+$/, "")}. Say yes to go ahead, or no to stop.`;
    case "needs_user_takeover":
      return e.message;
    case "done":
      return e.status === "booked"
        ? `Booked${e.reference ? `. Reference ${e.reference}` : ""}. It's on your calendar.`
        : "I can't see a confirmation on the page, so I'm not sure it went through. Please check the agent window.";
    case "failed":
      return `The booking didn't finish: ${e.reason.replace(/[.\s]+$/, "")}. The page is still open for you to finish by hand.`;
    case "cancelled":
      return `${e.message.replace(/[.\s]+$/, "")}.${e.holdBlockId ? " I've taken the hold off your calendar." : ""}`;
    default:
      return null;
  }
}

/** Reduce one event into the view. Exported for tests and the phone relay. */
export function reduceAgentEvent(v: AgentView, e: AgentEvent): AgentView {
  const announce = announceFor(e);
  const bump = announce ? { announce, seq: v.seq + 1 } : {};
  const clearPause = { question: null, field: null, summary: null, confirmKind: null, message: null };
  switch (e.type) {
    case "status":
      return { ...v, status: e.text, phase: e.state === "running" ? "running" : v.phase };
    case "timing":
      return { ...v, timing: { last: e.step, summary: e.summary } };
    case "progress":
      // Only while working: a late line never overwrites a question or result.
      if (v.phase !== "running" && v.phase !== "starting") return v;
      return { ...v, status: e.text, progress: e.text, progressSeq: v.progressSeq + 1 };
    case "step":
      return { ...v, log: [...v.log, { text: e.text, blocked: Boolean(e.blocked) }].slice(-60) };
    case "question":
      return { ...v, ...clearPause, ...bump, phase: "question", question: e.question, field: e.field, status: "Waiting for your answer" };
    case "needs_confirmation":
      return { ...v, ...clearPause, ...bump, phase: "confirm", summary: e.summary, confirmKind: e.kind, screenshot: e.screenshot, status: "Waiting for your yes" };
    case "needs_user_takeover":
      return { ...v, ...clearPause, ...bump, phase: "takeover", message: e.message, status: "Needs you in the browser window" };
    case "done":
      return {
        ...v,
        ...clearPause,
        ...bump,
        phase: "done",
        status: e.status === "booked" ? "Booked" : "Check the page",
        screenshot: e.screenshot,
        result: { status: e.status, reference: e.reference, confirmationText: e.confirmationText },
      };
    case "failed":
      return { ...v, ...clearPause, ...bump, phase: "failed", status: "Stopped — finish by hand", message: e.reason };
    case "cancelled":
      return { ...v, ...clearPause, ...bump, phase: "cancelled", status: "Stopped", message: e.message };
    default:
      return v;
  }
}

/** `silent` replays state without announcing it again (phone reload). */
export function applyAgentEvent(e: AgentEvent, remote = false, silent = false) {
  const next = reduceAgentEvent(view, e);
  set(silent ? { ...next, remote, seq: view.seq, announce: view.announce } : { ...next, remote });
  for (const tap of eventTaps) {
    try {
      tap(e);
    } catch {
      /* a broken tap must not stop the UI */
    }
  }
}

// ---------------------------------------------------------------------------
// Progress talker (laptop: it sees the raw step log). Its lines become
// `progress` events, shown on both devices and relayed to the phone.
// ---------------------------------------------------------------------------

let fillerBusy: () => boolean = () => false;
const fillerCancels = new Set<() => void>();

/** The voice loop says when real speech plays or the user is talking. */
export function setProgressBusy(fn: () => boolean) {
  fillerBusy = fn;
}

/** The voice loop stops a filler that's still playing when a real event lands. */
export function onFillerCancel(fn: () => void): () => void {
  fillerCancels.add(fn);
  return () => fillerCancels.delete(fn);
}

const talker = new ProgressTalker({
  emit: (text) => applyAgentEvent({ type: "progress", text }),
  cancel: () => {
    for (const fn of fillerCancels) fn();
  },
  // A phone-started run is spoken on the phone: the laptop can't hear it, so
  // it relies on the spoken-length estimate and the phone drops overlaps.
  busy: () => (view.origin === "phone" ? false : fillerBusy()),
});

let wired = false;
function ensureWired() {
  if (wired) return;
  wired = true;
  const d = desktop();
  if (!d) return;
  d.onEvent((e) => {
    applyAgentEvent(e);
    talker.handle(e);
    const said = announceFor(e);
    if (said) talker.noteSpeech(said);
    void runEndEffects(e);
  });
  // A reload mid-run picks the paused state back up.
  void d
    .state()
    .then((s) => {
      if (!s?.active) return;
      const p = s.pause;
      const base: Partial<AgentView> = { log: s.log ?? [] };
      if (p?.kind === "question") set({ ...base, phase: "question", question: p.question, field: p.field, status: "Waiting for your answer" });
      else if (p?.kind === "confirm") set({ ...base, phase: "confirm", summary: p.summary, confirmKind: (p.confirmKind as "final") ?? "final", status: "Waiting for your yes" });
      else if (p?.kind === "takeover") set({ ...base, phase: "takeover", message: p.message, status: "Needs you in the browser window" });
      else set({ ...base, phase: "running", status: "Working" });
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function startAgent(task: AgentTask, origin: "here" | "phone" = "here"): Promise<{ ok: boolean; error?: string }> {
  ensureWired();
  const b = backend();
  if (!b) return { ok: false, error: "The booking agent needs the Rocky desktop app." };
  if (isAgentActive()) return { ok: false, error: "A booking is already running. Say stop to end it first." };
  set({ ...IDLE, seq: view.seq, phase: "starting", status: "Opening page", remote: b.kind === "relay", origin });
  try {
    const r = await b.start(task);
    if (!r?.ok) {
      set({ phase: "idle", status: "" });
      return { ok: false, error: r?.error || "The agent didn't start." };
    }
    return { ok: true };
  } catch (e) {
    set({ phase: "idle", status: "" });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Open the agent window on the start page while the plan is being read back,
 * so the page is already loaded when the user says yes. Fire and forget.
 */
export function prepareAgent(task: AgentTask): void {
  const b = backend();
  if (!b?.prepare || isAgentActive()) return;
  void b.prepare(task).catch(() => {});
}

export async function answerAgent(text: string): Promise<boolean> {
  const b = backend();
  if (!b || view.phase !== "question") return false;
  const ok = await b.answer(text).catch(() => false);
  if (ok) set({ phase: "running", status: "Filling form", question: null, field: null });
  return ok;
}

export async function confirmAgent(yes: boolean): Promise<boolean> {
  const b = backend();
  if (!b || view.phase !== "confirm") return false;
  const ok = await b.confirm(yes).catch(() => false);
  if (ok && yes) set({ phase: "running", status: "Booking", summary: null, confirmKind: null });
  return ok;
}

export async function continueAgent(): Promise<boolean> {
  const b = backend();
  if (!b || view.phase !== "takeover") return false;
  const ok = await b.continue().catch(() => false);
  if (ok) set({ phase: "running", status: "Continuing", message: null });
  return ok;
}

export async function cancelAgent(): Promise<boolean> {
  const b = backend();
  if (!b || !isAgentActive()) return false;
  return b.cancel().catch(() => false);
}

/** Clear a finished run's card. */
export function dismissAgent() {
  if (isAgentActive()) return;
  set({ ...IDLE, seq: view.seq });
}

// ---------------------------------------------------------------------------
// Laptop effects when a run ends: calendar hold + local evidence.
// ---------------------------------------------------------------------------

async function runEndEffects(e: AgentEvent) {
  if (e.type !== "done" && e.type !== "failed" && e.type !== "cancelled") return;
  const holdId = e.holdBlockId;
  try {
    if (holdId) {
      const block = await db.scheduled_blocks.get(holdId);
      if (block) {
        if (e.type === "cancelled") {
          await db.scheduled_blocks.delete(holdId);
        } else if (e.type === "done") {
          const note = e.status === "booked"
            ? `Booked${e.reference ? ` · ref ${e.reference}` : ""}${e.confirmationText ? ` — "${e.confirmationText}"` : ""}`
            : "Booking not confirmed on the page — check it.";
          await db.scheduled_blocks.update(holdId, {
            title: finalHoldTitle(block.title, e.status, e.reference),
            notes: [block.notes, note].filter(Boolean).join("\n"),
          } as never);
        } else {
          await db.scheduled_blocks.update(holdId, {
            title: finalHoldTitle(block.title, "failed"),
            notes: [block.notes, `Agent stopped: ${e.reason}`].filter(Boolean).join("\n"),
          } as never);
        }
        emitDataChange("scheduled_blocks");
      }
    }
  } catch {
    /* the spoken result still tells the user */
  }
  if (e.type === "done" || e.type === "failed") {
    await saveBookingRecord({
      status: e.type === "done" ? e.status : "failed",
      type: e.type === "done" ? (e.task?.type ?? "") : "",
      venue: e.type === "done" ? (e.task?.venue ?? "") : "",
      date: e.type === "done" ? (e.task?.date ?? "") : "",
      time: e.type === "done" ? (e.task?.time ?? "") : "",
      reference: e.type === "done" ? e.reference : null,
      confirmation_text: e.type === "done" ? e.confirmationText : "",
      url: e.url ?? "",
      screenshot: e.type === "done" ? e.screenshot : null,
      hold_block_id: holdId,
      reason: e.type === "failed" ? e.reason : undefined,
    });
  }
}
