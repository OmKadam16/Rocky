/**
 * Phone "Connection check": six steps in order, each with a one-line result
 * and a fix. Pure runner over injected probes (tested with mocks in
 * connectionCheck.test.ts); connectionProbes() wires the real ones.
 * Key values are never read out — only present / missing.
 */
import { LAPTOP_ASLEEP_MESSAGE, pairFailureCopy, readLaptopLastSeen, readPhoneDevice, type PairFailureKind } from "./devices";
import { LAPTOP_OFFLINE_AFTER_SEC } from "./pairing";
import { secretPresence } from "./secrets";
import { currentUserId, isSupabaseConfigured, supabase, uniqueChannel } from "./supabase";
import { pingLaptop } from "./agentRelay";

export type CheckId = "signin" | "pair" | "heartbeat" | "realtime" | "keys" | "ping";
export type CheckState = "ok" | "fail" | "warn" | "skip";
export interface CheckStep {
  id: CheckId;
  label: string;
  state: CheckState;
  line: string;
  fix?: string;
}

export type ClaimOutcome = { ok: true } | { ok: false; kind: PairFailureKind; code: string | null; message: string };

export interface CheckProbes {
  userId: () => Promise<string | null>;
  /** The last claim on this screen (pair flow) — null when there wasn't one. */
  lastClaim: () => ClaimOutcome | null;
  /** Whether this phone already has a phone row (home screen). */
  phonePaired: () => Promise<{ name: string } | null>;
  laptop: () => Promise<{ lastSeenMs: number; name: string } | null>;
  realtime: () => Promise<boolean>;
  keys: () => Promise<{ llm: boolean; el: boolean }>;
  ping: () => Promise<{ ok: boolean; ms?: number; error?: string }>;
  now: () => number;
}

const LABELS: Record<CheckId, string> = {
  signin: "Signed in",
  pair: "Pairing code",
  heartbeat: "Laptop heartbeat",
  realtime: "Live updates",
  keys: "Shared API keys",
  ping: "Round trip",
};

export async function runConnectionCheck(p: CheckProbes, onStep?: (steps: CheckStep[]) => void): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  const push = (id: CheckId, state: CheckState, line: string, fix?: string) => {
    steps.push({ id, label: LABELS[id], state, line, fix });
    onStep?.([...steps]);
  };
  const skipRest = (from: CheckId[], why: string) => from.forEach((id) => push(id, "skip", why));

  // (a) signed in
  const uid = await p.userId().catch(() => null);
  if (!uid) {
    push("signin", "fail", "Not signed in on this phone.", "Sign in with the same account as your laptop.");
    skipRest(["pair", "heartbeat", "realtime", "keys", "ping"], "Skipped: sign in first.");
    return steps;
  }
  push("signin", "ok", "Signed in.");

  // (b) code accepted by claim_pair (pair flow), or already paired (home)
  const claim = p.lastClaim();
  const paired = await p.phonePaired().catch(() => null);
  if (claim && !claim.ok) {
    const copy = pairFailureCopy(claim.kind);
    push("pair", "fail", `${copy.title}${claim.code ? ` (${claim.code})` : ""}.`, copy.body);
  } else if (claim?.ok || paired) {
    push("pair", "ok", paired ? `Paired as ${paired.name}.` : "Code accepted.");
  } else {
    push("pair", "warn", "No code entered yet.", "Enter the 8-character code from your laptop (Profile → Devices).");
  }

  // (c) laptop heartbeat age
  const laptop = await p.laptop().catch(() => null);
  let laptopAwake = false;
  if (!laptop) {
    push("heartbeat", "fail", "No laptop on this account.", pairFailureCopy("no-laptop").body);
  } else {
    const age = Math.max(0, Math.round((p.now() - laptop.lastSeenMs) / 1000));
    laptopAwake = age <= LAPTOP_OFFLINE_AFTER_SEC;
    if (laptopAwake) push("heartbeat", "ok", `${laptop.name} was seen ${age} s ago.`);
    else push("heartbeat", "fail", `${laptop.name} was last seen ${formatAge(age)} ago.`, LAPTOP_ASLEEP_MESSAGE);
  }

  // (d) realtime channel
  const live = await p.realtime().catch(() => false);
  if (live) push("realtime", "ok", "Subscribed to live updates.");
  else push("realtime", "fail", "Couldn't subscribe to live updates.", "Check this phone's internet connection (or try off Wi-Fi), then run the check again.");

  // (e) shared API keys (present / missing only)
  const keys = await p.keys().catch(() => ({ llm: false, el: false }));
  if (keys.llm) push("keys", "ok", `Planner key present${keys.el ? ", ElevenLabs key present" : ""}.`);
  else push("keys", "fail", "Planner key missing for this account.", "On the laptop, open Rocky (the updated app) once so it shares its keys, or enter the key in Profile.");

  // (f) round trip through the commands relay
  if (!laptopAwake) {
    push("ping", "skip", "Skipped: the laptop isn't awake.", LAPTOP_ASLEEP_MESSAGE);
  } else {
    const r = await p.ping().catch((e) => ({ ok: false, error: String(e) }) as { ok: boolean; ms?: number; error?: string });
    if (r.ok) push("ping", "ok", `The laptop answered in ${r.ms} ms.`);
    else push("ping", "fail", r.error ?? "No answer from the laptop.", "Make sure the laptop runs the Rocky desktop app (not a browser tab) and is signed in with this account.");
  }
  return steps;
}

function formatAge(sec: number): string {
  if (sec < 120) return `${sec} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** Subscribe a throwaway channel to commands + devices; true once SUBSCRIBED. */
export function probeRealtime(timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const sb = supabase();
    let done = false;
    const channel = sb.channel(uniqueChannel("connection-check"));
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      void sb.removeChannel(channel);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    channel
      .on("postgres_changes", { event: "*", schema: "public", table: "commands" }, () => {})
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => {})
      .subscribe((status) => {
        if (status === "SUBSCRIBED") finish(true);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") finish(false);
      });
  });
}

/** The real probes. */
export function connectionProbes(phoneName: string, lastClaim: () => ClaimOutcome | null = () => null): CheckProbes {
  return {
    userId: () => (isSupabaseConfigured ? currentUserId() : Promise.resolve(null)),
    lastClaim,
    phonePaired: async () => {
      const row = await readPhoneDevice();
      return row ? { name: row.name } : null;
    },
    laptop: async () => {
      const l = await readLaptopLastSeen();
      return l ? { lastSeenMs: l.lastSeenMs, name: l.laptopName } : null;
    },
    realtime: () => probeRealtime(),
    keys: async () => {
      const p = await secretPresence();
      return { llm: p.llm_key, el: p.el_key };
    },
    ping: () => pingLaptop(phoneName),
    now: () => Date.now(),
  };
}
