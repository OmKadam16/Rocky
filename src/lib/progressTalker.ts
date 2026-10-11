/**
 * Spoken reassurance while the booking agent works ("One moment, checking
 * that."). Built in code from the agent's own events and a timer, never by a
 * model. Rules:
 *   - nothing said for FIRST_MS while the agent works -> one short filler;
 *     after that at most one every EVERY_MS;
 *   - never over real speech or while the user talks (`busy()`), never the
 *     same line twice in a row;
 *   - silent while the run is paused on the user (question, confirmation,
 *     takeover) and after it ends; a real event cancels a filler in flight.
 *
 * The laptop runs one talker per run (it sees the raw step log); its lines go
 * out as `progress` events, which the relay carries to the phone. Whichever
 * device the user is talking to speaks them (see useAssistant).
 */
import type { AgentEvent } from "./agentClient";

export type Activity = "opening" | "searching" | "filling" | "waiting" | "working" | "slow";

/** 3-4 short variants per state, each under ~6 words. */
export const FILLERS: Record<Activity, readonly string[]> = {
  working: ["One moment, checking that.", "Still on it.", "Working on it.", "Just a moment."],
  opening: ["Opening the booking page.", "Pulling up the site.", "Loading the booking page."],
  searching: ["Checking availability.", "Looking at open times.", "Checking what's free."],
  filling: ["Filling in your details.", "Adding your details now.", "Putting your details in."],
  waiting: ["Still waiting on the site, one moment.", "The page is still loading.", "Waiting on the site."],
  slow: ["This site is slow, still on it. You can say stop any time.", "Slow site, still going. Say stop any time."],
};

export const FIRST_MS = 3000;
export const EVERY_MS = 8000;
/** No progress from the agent for this long: the site (or model) is slow. */
export const SLOW_MS = 25000;
/** No step for this long: we're waiting on the page. */
const STALE_MS = 8000;
const TICK_MS = 500;
/** Rough speaking rate, to keep the clock honest about real speech. */
const MS_PER_CHAR = 65;

/** Events that mean a real voice line is coming, or the run stopped. */
const REAL = new Set(["question", "code_request", "needs_confirmation", "needs_user_takeover", "done", "failed", "cancelled"]);

/** What the agent is doing, read off its status line or step log. */
export function activityFor(e: AgentEvent): Exclude<Activity, "slow"> | null {
  if (e.type === "status") {
    if (/opening/i.test(e.text)) return "opening";
    if (/filling/i.test(e.text)) return "filling";
    return null;
  }
  if (e.type !== "step") return null;
  const t = e.text.toLowerCase();
  if (t.startsWith("opened")) return "opening";
  if (t.startsWith("typed")) return "filling";
  if (t.startsWith("waited")) return "waiting";
  if (t.startsWith("scrolled")) return "searching";
  if (/^(double-)?clicked/.test(t) && /time|date|avail|search|find|slot|day|month|calendar|\d|am\b|pm\b|next|guests?|party/.test(t)) return "searching";
  return null;
}

export type TalkerOptions = {
  /** Say/show one line. */
  emit: (text: string) => void;
  /** Stop a filler that's still playing (a real event arrived). */
  cancel?: () => void;
  /** True while real speech plays or the user is talking. */
  busy?: () => boolean;
  now?: () => number;
  random?: () => number;
};

export class ProgressTalker {
  private working = false;
  private activity: Exclude<Activity, "slow"> = "working";
  private lastSpokeAt: number;
  private lastWasFiller = false;
  private lastActivityAt: number;
  private lastLine: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: TalkerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.lastSpokeAt = this.now();
    this.lastActivityAt = this.now();
  }

  /** Feed every agent event (laptop: raw events, with the step log). */
  handle(e: AgentEvent) {
    const now = this.now();
    if (REAL.has(e.type)) {
      const wasWorking = this.working;
      this.working = false;
      this.stopTimer();
      if (wasWorking) this.opts.cancel?.();
      return;
    }
    if (e.type === "status") {
      if (e.state === "running" && !this.working) this.begin();
    }
    const a = activityFor(e);
    if (a) this.activity = a;
    if (e.type === "step" || e.type === "status" || e.type === "timing") this.lastActivityAt = now;
  }

  /** Real speech (an announcement or a reply) is playing for about this text. */
  noteSpeech(text: string) {
    this.lastSpokeAt = Math.max(this.lastSpokeAt, this.now() + text.length * MS_PER_CHAR);
    this.lastWasFiller = false;
  }

  /** The run started or resumed. */
  begin() {
    const now = this.now();
    this.working = true;
    this.lastSpokeAt = Math.max(this.lastSpokeAt, now);
    this.lastWasFiller = false;
    this.lastActivityAt = now;
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.working = false;
    this.stopTimer();
  }

  get active() {
    return this.working;
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests; the interval calls it. */
  tick() {
    if (!this.working) return;
    const now = this.now();
    if (this.opts.busy?.()) {
      // Someone is talking: the quiet clock restarts when they stop.
      this.lastSpokeAt = Math.max(this.lastSpokeAt, now);
      return;
    }
    const gap = this.lastWasFiller ? EVERY_MS : FIRST_MS;
    if (now - this.lastSpokeAt < gap) return;
    const idle = now - this.lastActivityAt;
    const state: Activity = idle >= SLOW_MS ? "slow" : idle >= STALE_MS ? "waiting" : this.activity;
    const line = this.pick(state);
    this.lastLine = line;
    this.lastSpokeAt = now + line.length * MS_PER_CHAR;
    this.lastWasFiller = true;
    this.opts.emit(line);
  }

  private pick(state: Activity): string {
    const options = FILLERS[state].filter((l) => l !== this.lastLine);
    return options[Math.floor(this.random() * options.length) % options.length];
  }
}
