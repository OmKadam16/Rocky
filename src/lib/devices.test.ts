import { describe, expect, it } from "vitest";
import { detectPairClaim } from "./pairClaim";
import { mapDbErrcode, statusFromLastSeen } from "./devices";
import { LAPTOP_OFFLINE_AFTER_SEC } from "./pairing";

const iso = (ms: number) => new Date(ms).toISOString();
const OPTS = { publishedCode: "K7P2QM", published: true, createdAtMs: 1_000_000 };

describe("detectPairClaim (claim detection from rows)", () => {
  it("claims when the laptop row's pair_code went null after publishing", () => {
    const res = detectPairClaim(
      { pair_code: null, name: "My laptop", last_seen: iso(999_000), created_at: iso(900_000) },
      null,
      OPTS,
    );
    expect(res.claimed).toBe(true);
  });

  it("does not claim on a null pair_code that was never published", () => {
    const res = detectPairClaim(
      { pair_code: null, name: "My laptop", last_seen: iso(999_000), created_at: iso(900_000) },
      null,
      { ...OPTS, published: false },
    );
    expect(res.claimed).toBe(false);
  });

  it("claims when the phone row looks fresh (last_seen after code creation)", () => {
    const res = detectPairClaim(
      { pair_code: "K7P2QM", name: "My laptop", last_seen: iso(999_000), created_at: iso(900_000) },
      { pair_code: null, name: "My phone", last_seen: iso(1_000_100), created_at: iso(1_000_100) },
      OPTS,
    );
    expect(res.claimed).toBe(true);
    expect(res.phoneName).toBe("My phone");
  });

  it("ignores a stale phone row paired long ago", () => {
    const res = detectPairClaim(
      { pair_code: "K7P2QM", name: "My laptop", last_seen: iso(999_000), created_at: iso(900_000) },
      { pair_code: null, name: "My phone", last_seen: iso(500_000), created_at: iso(400_000) },
      OPTS,
    );
    expect(res.claimed).toBe(false);
    expect(res.phoneName).toBe("My phone");
  });

  it("falls back to created_at when last_seen is missing", () => {
    const res = detectPairClaim(
      { pair_code: "K7P2QM", name: "My laptop", last_seen: iso(999_000), created_at: iso(900_000) },
      { pair_code: null, name: "  ", last_seen: null, created_at: iso(1_000_050) },
      OPTS,
    );
    expect(res.claimed).toBe(true);
    expect(res.phoneName).toBeNull();
  });
});

describe("statusFromLastSeen (laptop online/offline threshold)", () => {
  it("maps freshness to connecting/online/offline at 45 s", () => {
    const now = 1_000_000;
    expect(LAPTOP_OFFLINE_AFTER_SEC).toBe(45);
    expect(statusFromLastSeen(null, now)).toBe("connecting");
    expect(statusFromLastSeen(now, now)).toBe("online");
    expect(statusFromLastSeen(now - 30_000, now)).toBe("online");
    expect(statusFromLastSeen(now - 45_000, now)).toBe("online"); // boundary: strictly older
    expect(statusFromLastSeen(now - 45_001, now)).toBe("offline");
    expect(statusFromLastSeen(now - 300_000, now)).toBe("offline");
  });
});

describe("mapDbErrcode (pairing failures by errcode)", () => {
  it("maps stable Postgres errcodes", () => {
    expect(mapDbErrcode("P0001")).toBe("expired");
    expect(mapDbErrcode("P0002")).toBe("wrong");
    expect(mapDbErrcode("28000")).toBe("not-signed-in");
    expect(mapDbErrcode("42501")).toBe("not-signed-in");
    expect(mapDbErrcode("401")).toBe("not-signed-in");
    expect(mapDbErrcode("XXXXX")).toBeNull();
    expect(mapDbErrcode(null)).toBeNull();
  });
});
