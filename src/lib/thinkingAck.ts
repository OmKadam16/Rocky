/**
 * "One moment." while the planner thinks. Built in code, never by a model:
 * if the reply isn't back within ACK_DELAY_MS, Rocky says one short line
 * that fits the request; if it is still thinking after STILL_MS, one more
 * ("Still on it."). The real reply waits for a line that's playing, so they
 * never talk over each other. Tested with fake timers (thinkingAck.test.ts).
 */

export const ACK_DELAY_MS = 600;
export const STILL_MS = 9000;

const LINES = {
  remove: ["One moment, let me find those.", "Give me a second, checking what's there.", "One sec, looking at that."],
  change: ["One moment.", "On it, one second.", "Give me a second.", "Sure, one moment."],
  question: ["Let me check.", "One moment, checking your calendar.", "Give me a second to look."],
  yes: ["On it.", "Okay, one moment.", "Doing that now."],
  other: ["One moment.", "Give me a second.", "Just a second."],
} as const;

export const STILL_LINES = ["Still on it.", "Almost there.", "Still working on it."] as const;

/** Every line Rocky may say as an acknowledgement (for echo filtering). */
export const ALL_ACK_LINES: readonly string[] = [...Object.values(LINES).flat(), ...STILL_LINES];

export type AckKind = keyof typeof LINES;

export function ackKind(text: string): AckKind {
  const t = text.trim().toLowerCase();
  if (/^(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|confirm(ed)?)\b/.test(t)) return "yes";
  if (/\b(remove|delete|clear|cancel|get rid of|wipe|erase|drop)\b/.test(t)) return "remove";
  if (/\b(add|schedule|book|put|plan|move|reschedule|shift|push|swap|switch|change|set up|block out|make)\b/.test(t)) return "change";
  if (/^(what|when|where|who|how|which|why|do i|am i|is|are|have i|did i|can you tell)\b/.test(t) || t.endsWith("?")) return "question";
  return "other";
}

export function pickAck(text: string, random: () => number = Math.random): string {
  const pool = LINES[ackKind(text)];
  return pool[Math.floor(random() * pool.length) % pool.length];
}

export type ThinkingAck = {
  /** The reply is ready: stop timers, wait for a line that's still playing. */
  finish: () => Promise<void>;
  /** Stop everything now (the turn was cancelled). */
  cancel: () => void;
};

/**
 * Starts the acknowledgement clock for one planner turn.
 * `say(line, signal)` speaks a line and resolves when it's done.
 */
export function startThinkingAck(
  text: string,
  say: (line: string, signal: AbortSignal) => Promise<void>,
  opts: { delayMs?: number; stillMs?: number; random?: () => number; onLine?: (line: string) => void } = {},
): ThinkingAck {
  const random = opts.random ?? Math.random;
  const abort = new AbortController();
  let playing: Promise<void> | null = null;
  let done = false;
  const play = (line: string) => {
    if (done || playing) return;
    opts.onLine?.(line);
    playing = say(line, abort.signal)
      .catch(() => {})
      .finally(() => {
        playing = null;
      });
  };
  const first = setTimeout(() => play(pickAck(text, random)), opts.delayMs ?? ACK_DELAY_MS);
  const still = setTimeout(() => play(STILL_LINES[Math.floor(random() * STILL_LINES.length) % STILL_LINES.length]), opts.stillMs ?? STILL_MS);
  const stopTimers = () => {
    done = true;
    clearTimeout(first);
    clearTimeout(still);
  };
  return {
    async finish() {
      stopTimers();
      if (playing) await playing;
    },
    cancel() {
      stopTimers();
      abort.abort();
    },
  };
}
