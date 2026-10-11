import { useEffect, useState } from "react";
import { isSupabaseConfigured, supabase, uniqueChannel } from "./supabase";
import { HEARTBEAT_MS, LAPTOP_OFFLINE_AFTER_SEC } from "./pairing";

/**
 * Supabase `devices` pairing layer. Logic ported from Rocky-Planner;
 * every realtime channel uses uniqueChannel() so re-subscribes never clash.
 */

// ---------------------------------------------------------------------------
// Pairing failures — mapped by Postgres errcode, never by message sniffing.
// "Laptop offline" is NEVER produced here: it is decided only from
// devices.last_seen (see statusFromLastSeen).
// ---------------------------------------------------------------------------

/** Stable failure kinds for pairing UI. */
export type PairFailureKind =
  | "expired" // P0001: code past pair_expires_at
  | "wrong" // P0002: no active code for this account
  | "not-signed-in" // 28000 / 401 / 42501: no usable session
  | "unknown"; // anything else — UI shows error.message in small text

export class PairError extends Error {
  kind: PairFailureKind;
  constructor(kind: PairFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Map a Postgres/PostgREST errcode to a failure kind (null = unknown). */
export function mapDbErrcode(code: string | null | undefined): PairFailureKind | null {
  switch (code) {
    case "P0001":
      return "expired";
    case "P0002":
      return "wrong";
    case "28000": // claim_pair: auth.uid() is null
    case "42501": // RLS / permission denied (session missing or unusable)
    case "401": // PostgREST: unauthenticated
      return "not-signed-in";
    default:
      return null;
  }
}

export interface DbLikeError {
  code?: string | null;
  message: string;
}

/** Build a PairError from a DB/PostgREST error, preserving the message. */
export function mapPairFailure(error: DbLikeError): PairError {
  const kind = mapDbErrcode(error.code ?? null) ?? "unknown";
  return new PairError(kind, error.message);
}

export interface ClaimPairResult {
  laptopName: string;
  laptopDeviceId: string;
  phoneDeviceId: string;
}

/**
 * Phone claims a laptop pairing code. Requires a session — with none,
 * auth.uid() is null inside claim_pair and every code looks dead, which is
 * why callers redirect to sign in on 'not-signed-in' instead of
 * showing "laptop offline".
 */
export async function claimPair(code: string, phoneName: string): Promise<ClaimPairResult> {
  if (!isSupabaseConfigured) {
    throw new PairError("unknown", "Supabase is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).");
  }
  const sb = supabase();
  const { data: sessionData } = await sb.auth.getSession();
  if (!sessionData.session) {
    throw new PairError("not-signed-in", "No session — sign in first.");
  }
  const { data, error } = await sb.rpc("claim_pair", { code, phone_name: phoneName });
  if (error) throw mapPairFailure(error);
  const row = data as { laptop_name?: string; laptop_device_id?: string; phone_device_id?: string } | null;
  return {
    laptopName: row?.laptop_name ?? "your laptop",
    laptopDeviceId: row?.laptop_device_id ?? "",
    phoneDeviceId: row?.phone_device_id ?? "",
  };
}

export type PublishResult = { ok: true } | { ok: false; failure: PairError };

/**
 * Laptop publishes a fresh pairing code. Surfaces the REAL failure —
 * callers must show it with a Retry button, never a QR for an unsaved code.
 */
export async function publishLaptopPairing(code: string, expiresAtMs: number, laptopName: string): Promise<PublishResult> {
  if (!isSupabaseConfigured) {
    return { ok: false, failure: new PairError("unknown", "Supabase is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).") };
  }
  const sb = supabase();
  const { data: sessionData } = await sb.auth.getSession();
  if (!sessionData.session) {
    return { ok: false, failure: new PairError("not-signed-in", "No session — sign in first.") };
  }
  const { error } = await sb.from("devices").upsert(
    {
      role: "laptop",
      name: laptopName,
      pair_code: code,
      pair_expires_at: new Date(expiresAtMs).toISOString(),
      last_seen: new Date().toISOString(),
    },
    { onConflict: "user_id,role" },
  );
  if (error) return { ok: false, failure: mapPairFailure(error) };
  return { ok: true };
}

/** Refresh devices.last_seen for this account's laptop row (every 15 s while open). */
export async function touchLaptopHeartbeat(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const sb = supabase();
    const { error } = await sb.from("devices").update({ last_seen: new Date().toISOString() }).eq("role", "laptop");
    return !error;
  } catch {
    return false; // offline: fetch throws
  }
}

/** One failed heartbeat is retried once after this long. */
export const HEARTBEAT_RETRY_MS = 3000;

export type BeatReason = "start" | "interval" | "focus" | "online" | "visible" | "resume" | "retry";

/**
 * The laptop heartbeat loop (pure; timers are the global ones, so tests use
 * fake timers). Beats right away, every `intervalMs`, and whenever `beat()` is
 * called (focus, network back, wake from sleep). A failed beat is retried once
 * after `retryMs`; overlapping beats are skipped.
 */
export function createHeartbeat(
  touch: () => Promise<boolean>,
  opts: { intervalMs?: number; retryMs?: number; onResult?: (ok: boolean, reason: BeatReason) => void } = {},
) {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_MS;
  const retryMs = opts.retryMs ?? HEARTBEAT_RETRY_MS;
  let inflight = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const beat = async (reason: BeatReason): Promise<boolean> => {
    if (stopped || inflight) return false;
    inflight = true;
    let ok = false;
    try {
      ok = await touch();
    } catch {
      ok = false;
    } finally {
      inflight = false;
    }
    opts.onResult?.(ok, reason);
    if (!ok && reason !== "retry" && !stopped && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void beat("retry");
      }, retryMs);
    }
    return ok;
  };

  void beat("start");
  const interval = setInterval(() => void beat("interval"), intervalMs);
  return {
    beat,
    stop() {
      stopped = true;
      clearInterval(interval);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}

export interface LaptopPresence {
  lastSeenMs: number;
  laptopName: string;
}

/**
 * Read this account's laptop row for a last_seen offline check.
 * Returns null when no laptop row exists yet (fresh account).
 * "Laptop offline" <=> now - lastSeenMs > 45 s. Nothing else decides it.
 */
export async function readLaptopLastSeen(): Promise<LaptopPresence | null> {
  if (!isSupabaseConfigured) return null;
  const sb = supabase();
  const { data, error } = await sb.from("devices").select("name,last_seen").eq("role", "laptop").limit(1).maybeSingle();
  if (error || !data) return null;
  const row = data as { name: string | null; last_seen: string };
  return { lastSeenMs: new Date(row.last_seen).getTime(), laptopName: row.name ?? "your laptop" };
}

export interface PhoneDevice {
  id: string;
  name: string;
  last_seen: string;
}

/** This account's phone row, if a phone already paired. */
export async function readPhoneDevice(): Promise<PhoneDevice | null> {
  if (!isSupabaseConfigured) return null;
  const sb = supabase();
  const { data, error } = await sb.from("devices").select("id,name,last_seen").eq("role", "phone").limit(1).maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; name: string | null; last_seen: string };
  return { id: row.id, name: row.name ?? "this phone", last_seen: row.last_seen };
}

/** Rename this account's laptop row (phone settings sheet). */
export async function updateLaptopName(name: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  const sb = supabase();
  const clean = name.trim().slice(0, 40);
  if (!clean) return;
  const { error } = await sb.from("devices").update({ name: clean }).eq("role", "laptop");
  if (error) throw mapPairFailure(error);
}

/** Remove this account's phone row. The laptop row is left untouched. */
export async function unpairPhone(): Promise<void> {
  if (!isSupabaseConfigured) return;
  const sb = supabase();
  const { error } = await sb.from("devices").delete().eq("role", "phone");
  if (error) throw mapPairFailure(error);
}

export interface PairDeviceRow {
  id: string;
  role: "laptop" | "phone";
  name: string | null;
  last_seen: string;
  pair_code: string | null;
  pair_expires_at: string | null;
  created_at: string | null;
}

/** Both pairing rows for the claim check + paired-devices list. */
export async function readPairDevices(): Promise<{ laptop: PairDeviceRow | null; phone: PairDeviceRow | null }> {
  if (!isSupabaseConfigured) return { laptop: null, phone: null };
  const sb = supabase();
  const { data, error } = await sb
    .from("devices")
    .select("id,role,name,last_seen,pair_code,pair_expires_at,created_at")
    .in("role", ["laptop", "phone"]);
  if (error || !data) return { laptop: null, phone: null };
  const rows = data as PairDeviceRow[];
  return { laptop: rows.find((r) => r.role === "laptop") ?? null, phone: rows.find((r) => r.role === "phone") ?? null };
}

// ---------------------------------------------------------------------------
// Laptop presence — the ONLY source of the online/offline chip.
// ---------------------------------------------------------------------------

/** What the phone says when the laptop's heartbeat is older than 45 s. */
export const LAPTOP_ASLEEP_MESSAGE = "Your laptop is asleep or closed. Wake it and open Rocky.";

export type PresenceStatus = "connecting" | "online" | "offline";

export function statusFromLastSeen(lastSeenMs: number | null, now: number = Date.now()): PresenceStatus {
  if (lastSeenMs == null) return "connecting";
  return now - lastSeenMs > LAPTOP_OFFLINE_AFTER_SEC * 1000 ? "offline" : "online";
}

export interface LaptopPresenceState {
  status: PresenceStatus;
  laptopName: string;
  lastSeenMs: number | null;
}

/** Polls + subscribes to the laptop row; offline <=> last_seen older than 45 s. */
export function useLaptopPresence(enabled: boolean): LaptopPresenceState {
  const [state, setState] = useState<LaptopPresenceState>({ status: "connecting", laptopName: "your laptop", lastSeenMs: null });

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured) return;
    let alive = true;
    const refresh = async () => {
      const presence = await readLaptopLastSeen();
      if (!alive) return;
      if (!presence) {
        // No laptop row yet (fresh account): stay "connecting",
        // never claim offline without a last_seen to judge.
        setState((s) => ({ ...s, status: "connecting" }));
        return;
      }
      setState({ status: statusFromLastSeen(presence.lastSeenMs), laptopName: presence.laptopName, lastSeenMs: presence.lastSeenMs });
    };

    void refresh();
    const tick = window.setInterval(refresh, 5000);
    const sb = supabase();
    const channel = sb
      .channel(uniqueChannel("remote-laptop-presence"))
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => void refresh())
      .subscribe();
    return () => {
      alive = false;
      window.clearInterval(tick);
      void sb.removeChannel(channel);
    };
  }, [enabled]);

  return state;
}

type PowerBridge = { keepAwake: (on: boolean) => Promise<boolean>; onResume: (h: () => void) => () => void };
const powerBridge = (): PowerBridge | null =>
  (typeof window !== "undefined" && (window as unknown as { rocky?: { power?: PowerBridge } }).rocky?.power) || null;

/**
 * Laptop heartbeat: last_seen now, every 15 s, and again on window focus,
 * network back online, tab visible and wake from sleep (desktop), with one
 * retry 3 s after a failure. The desktop window isn't throttled when
 * minimized (backgroundThrottling: false in electron/main.cjs).
 */
export function useLaptopHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isSupabaseConfigured) return;
    const hb = createHeartbeat(touchLaptopHeartbeat);
    const onFocus = () => void hb.beat("focus");
    const onOnline = () => void hb.beat("online");
    const onVisible = () => document.visibilityState === "visible" && void hb.beat("visible");
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const offResume = powerBridge()?.onResume(() => void hb.beat("resume"));
    return () => {
      hb.stop();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      offResume?.();
    };
  }, [enabled]);
}

/**
 * Desktop: while a phone is paired, ask the OS not to suspend Rocky
 * (powerSaveBlocker "prevent-app-suspension" in main); released on unpair
 * and on quit.
 */
export function usePhoneKeepAwake(enabled: boolean): void {
  useEffect(() => {
    const power = powerBridge();
    if (!enabled || !power || !isSupabaseConfigured) return;
    let alive = true;
    const check = async () => {
      const phone = await readPhoneDevice().catch(() => null);
      if (alive) void power.keepAwake(phone != null).catch(() => {});
    };
    void check();
    const id = window.setInterval(() => void check(), 60_000);
    const sb = supabase();
    const channel = sb
      .channel(uniqueChannel("laptop-keep-awake"))
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => void check())
      .subscribe();
    return () => {
      alive = false;
      window.clearInterval(id);
      void sb.removeChannel(channel);
      void power.keepAwake(false).catch(() => {});
    };
  }, [enabled]);
}

/** "Seen X ago" helper for paired-device rows. */
export function formatSeenAgo(lastSeen: string | null, nowMs: number): string {
  if (!lastSeen) return "never seen";
  const ms = Date.parse(lastSeen);
  if (Number.isNaN(ms)) return "never seen";
  const diff = Math.max(0, nowMs - ms);
  if (diff < 15_000) return "seen just now";
  if (diff < 60_000) return `seen ${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `seen ${Math.round(diff / 60_000)}m ago`;
  return `seen ${Math.round(diff / 3_600_000)}h ago`;
}

export function deviceOnline(lastSeen: string | null, nowMs: number): boolean {
  if (!lastSeen) return false;
  const ms = Date.parse(lastSeen);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms <= LAPTOP_OFFLINE_AFTER_SEC * 1000;
}
