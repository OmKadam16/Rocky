/**
 * Claim detection for pairing (pure, unit-tested in devices.test.ts).
 * Logic ported from Rocky-Planner.
 *
 * The phone claims a code via the `claim_pair(code)` RPC, which — on success —
 * clears the laptop row's pair_code/pair_expires_at (single use) and inserts
 * or touches the phone row (name + last_seen = now()). The laptop notices the
 * claim in two ways at once (Realtime on `devices` + 2 s poll fallback); both
 * paths funnel through detectPairClaim() so the UI rule lives in one place.
 *
 * Claimed when EITHER holds (and the current code was actually published):
 *   1. the laptop row's pair_code is null — claim_pair cleared it, single use;
 *   2. the phone row looks fresh — last_seen (or created_at) >= createdAtMs,
 *      i.e. the phone row changed after this code was created.
 *
 * The phone's display name comes from the devices phone row.
 */

export interface ClaimDeviceSnapshot {
  pair_code: string | null;
  name: string | null;
  last_seen: string | null;
  created_at?: string | null;
}

export interface DetectClaimOptions {
  /** Stored form of the code currently on screen (no dash). */
  publishedCode: string;
  /** True only when the current code was actually saved to the relay. */
  published: boolean;
  /** Date.now() when the current code was generated. */
  createdAtMs: number;
}

export interface DetectClaimResult {
  claimed: boolean;
  /** Phone row's name (null when no phone row / blank name). */
  phoneName: string | null;
}

function cleanName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function detectPairClaim(
  laptop: ClaimDeviceSnapshot | null,
  phone: ClaimDeviceSnapshot | null,
  opts: DetectClaimOptions,
): DetectClaimResult {
  const phoneName = cleanName(phone?.name ?? null);
  if (!opts.published || !opts.publishedCode) {
    return { claimed: false, phoneName };
  }
  // Single-use clear: claim_pair() sets pair_code = null on success while our
  // code was on screen. A null pair_code with no publish behind it (fresh
  // account, publish failure) must NOT count — hence the published guard.
  if (laptop && laptop.pair_code == null) {
    return { claimed: true, phoneName };
  }
  // Fresh phone row: last_seen (or created_at) at/after this code was made.
  // A phone paired long ago has an older last_seen, so it does not trigger.
  if (phone) {
    const seenMs = parseMs(phone.last_seen);
    if (seenMs != null && seenMs >= opts.createdAtMs) {
      return { claimed: true, phoneName };
    }
    const createdMs = parseMs(phone.created_at ?? null);
    if (createdMs != null && createdMs >= opts.createdAtMs) {
      return { claimed: true, phoneName };
    }
  }
  return { claimed: false, phoneName };
}
