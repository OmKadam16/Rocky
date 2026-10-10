/**
 * Phone pairing helpers — pure functions (unit-tested in pairing.test.ts).
 * Logic ported from Rocky-Planner; styling lives in the components.
 *
 * Contract (shared with the devices table + claim_pair()):
 *   devices(id, user_id, role laptop|phone, name, last_seen,
 *           pair_code, pair_expires_at)
 *   QR payload: https://<site>/remote?pair=<CODE> (SPA rewrite)
 *   Code: 8 Crockford chars, STORED without dash, SHOWN as XXXX-XXXX,
 *         accepted with or without the dash (legacy 6-char codes still accepted).
 */

export const PAIR_CODE_LEN = 8;
export const PAIR_EXPIRY_MIN = 5;
export const PAIR_EXPIRY_SEC = PAIR_EXPIRY_MIN * 60;
/**
 * Static codes live ~10 years: one QR per user that never changes.
 * Far-future (not null) so the devices CHECK constraint and the
 * claim_pair expiry guard keep working with no schema change.
 */
export const STATIC_PAIR_EXPIRY_YEARS = 10;
/** Phone shows "laptop offline" when devices.last_seen is older than this. */
export const LAPTOP_OFFLINE_AFTER_SEC = 45;
/** Laptop presence heartbeat interval. */
export const HEARTBEAT_MS = 15_000;

/** Crockford base32 without ambiguous chars (no 0/O, 1/I/L). */
export const CROCKFORD = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export type LaptopPairStatus = "waiting" | "confirming" | "connected" | "expired" | "wrong" | "offline";

export type PhonePairState =
  | "intro"
  | "code"
  | "confirming"
  | "connected"
  | "expired"
  | "wrong"
  | "offline"
  | "generic";

/** Shape of the Supabase `devices` row relevant to pairing. */
export interface DeviceRow {
  id: string;
  user_id: string;
  role: "laptop" | "phone";
  name: string | null;
  last_seen: string;
  pair_code: string | null;
  pair_expires_at: string | null;
}

export function generatePairCode(random: () => number = Math.random): string {
  let out = "";
  // crypto.getRandomValues path is used by callers via randomCrypto below;
  // this default keeps the function pure/testable.
  for (let i = 0; i < PAIR_CODE_LEN; i++) {
    out += CROCKFORD[Math.floor(random() * CROCKFORD.length)];
  }
  return out;
}

/** Secure 6-char code via WebCrypto (stored form, no dash). */
export function generateSecurePairCode(): string {
  const buf = new Uint32Array(PAIR_CODE_LEN);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < PAIR_CODE_LEN; i++) {
    out += CROCKFORD[buf[i] % CROCKFORD.length];
  }
  return out;
}

/** Display form: XXXX-XXXX (legacy 6-char codes show as XXX-XXX). */
export function formatPairCode(stored: string): string {
  const n = normalizePairCode(stored);
  if (n.length === 8) return `${n.slice(0, 4)}-${n.slice(4)}`;
  if (n.length === 6) return `${n.slice(0, 3)}-${n.slice(3)}`;
  return stored.toUpperCase();
}

/** Normalize user input: uppercase, drop dashes/spaces. Stored form. */
export function normalizePairCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidPairCode(input: string): boolean {
  const n = normalizePairCode(input);
  // 8 chars current; legacy 6-char codes stay accepted during the transition.
  if (n.length !== PAIR_CODE_LEN && n.length !== 6) return false;
  return [...n].every((c) => CROCKFORD.includes(c));
}

/** Expiry timestamp for a fresh code (ms since epoch). */
export function freshPairExpiry(now: number = Date.now()): number {
  return now + PAIR_EXPIRY_SEC * 1000;
}

/** Expiry for a static code (ms since epoch). */
export function farFuturePairExpiry(now: number = Date.now()): number {
  return now + STATIC_PAIR_EXPIRY_YEARS * 365 * 24 * 3600 * 1000;
}

/**
 * Static-code rule: reuse the laptop row's existing code whenever it is a
 * valid code, regardless of its expiry (publishing bumps the expiry to
 * far-future). Generate only when the row has no usable code.
 */
export function shouldReusePairCode(pairCode: string | null | undefined): boolean {
  if (!pairCode) return false;
  return isValidPairCode(pairCode);
}

export function isPairExpired(expiresAtMs: number, now: number = Date.now()): boolean {
  return now >= expiresAtMs;
}

export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** QR payload: https://<site>/remote?pair=<CODE> (stored form, no dash). */
export function buildPairUrl(siteOrigin: string, storedCode: string): string {
  const origin = siteOrigin.replace(/\/$/, "");
  return `${origin}/remote?pair=${normalizePairCode(storedCode)}`;
}

/**
 * Which site origin the pairing QR encodes. VITE_PUBLIC_URL (when set)
 * wins so the laptop can show a QR for the deployed site while running
 * locally; otherwise the page's own origin is used (correct on Render).
 */
export function resolvePairOrigin(publicUrlEnv: string | undefined | null, locationOrigin: string): string {
  const env = (publicUrlEnv ?? "").trim().replace(/\/$/, "");
  if (env) return env;
  return locationOrigin.replace(/\/$/, "");
}

/** Read ?pair= from a query string; returns stored form or null. */
export function parsePairParam(search: string): string | null {
  try {
    const code = new URLSearchParams(search).get("pair");
    if (!code) return null;
    const n = normalizePairCode(code);
    return isValidPairCode(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Extract a pairing code from scanned QR text (full URL payload or raw
 * code with/without dash). Returns stored form or null.
 */
export function extractPairFromQrText(text: string): string | null {
  const t = text.trim();
  try {
    const u = new URL(t);
    const fromParam = parsePairParam(u.search);
    if (fromParam) return fromParam;
  } catch {
    /* not a URL — try raw code below */
  }
  const n = normalizePairCode(t);
  return isValidPairCode(n) ? n : null;
}

/** Generic device names — never hard-code personal data. */
export function defaultLaptopName(): string {
  try {
    const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = ua.userAgentData?.platform;
    if (platform) return `My ${platform} laptop`;
  } catch {
    /* ignore */
  }
  return "My laptop";
}

export function defaultPhoneName(): string {
  try {
    const ua = navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } };
    if (ua.userAgentData?.mobile) {
      return ua.userAgentData.platform ? `My ${ua.userAgentData.platform} phone` : "My phone";
    }
    if (/Android/i.test(navigator.userAgent)) return "My Android phone";
  } catch {
    /* ignore */
  }
  return "My phone";
}

/** Android Chrome supports vibration; iOS does not. Never throws. */
export function buzz(pattern: number | number[] = 15): void {
  try {
    if ("vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}
