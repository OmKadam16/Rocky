/**
 * Network failures, made legible. A bare "Failed to fetch" says nothing
 * about which of the four services (planner, voice-to-text, voice reply,
 * calendar sync) dropped, so every call site names itself, retries once on
 * a network blip, and records the failure in a small local log (step,
 * service and the browser's message only: never user text, never keys).
 */

export type Service = "planner" | "voice-to-text" | "voice reply" | "calendar";

const HOST: Record<Service, string> = {
  planner: "the AI model",
  "voice-to-text": "ElevenLabs (voice-to-text)",
  "voice reply": "ElevenLabs (voice reply)",
  calendar: "your calendar (Supabase)",
};

/** The browser's own words for "the request never got an answer". */
export function isNetworkError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? "");
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError") return false;
  return /failed to fetch|networkerror|network error|load failed|connection error|err_network|err_internet_disconnected|err_connection/i.test(m);
}

/** One plain sentence for the user. */
export function describeFailure(service: Service, e: unknown): string {
  if (isNetworkError(e)) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return offline
      ? `You're offline, so I couldn't reach ${HOST[service]}. Check your internet and try again.`
      : `I couldn't reach ${HOST[service]} (the connection dropped). Try again in a moment.`;
  }
  const m = e instanceof Error ? e.message : String(e);
  return `${HOST[service][0].toUpperCase()}${HOST[service].slice(1)} failed: ${m.slice(0, 160)}`;
}

/** Runs `fn`, and once more after `delayMs` if it failed with a network error. */
export async function withNetRetry<T>(fn: () => Promise<T>, opts: { retries?: number; delayMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isNetworkError(e) || opts.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 800));
    }
  }
}

// ---------------------------------------------------------------------------
// Local error log (last 20), shown in the vc-debug readout.
// ---------------------------------------------------------------------------

export type ErrorEntry = { at: number; service: Service; message: string };
const LOG_KEY = "rocky-error-log";

export function logFailure(service: Service, e: unknown): void {
  try {
    const message = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);
    const log = readErrorLog();
    log.push({ at: Date.now(), service, message });
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-20)));
    console.warn(`[rocky] ${service} failed: ${message}`);
  } catch {
    /* storage unavailable */
  }
}

export function readErrorLog(): ErrorEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
