import { describe, expect, it, vi } from "vitest";

// The real probes touch Supabase; the runner is tested with mocks only.
vi.mock("./supabase", () => ({ isSupabaseConfigured: true, supabase: () => ({}), uniqueChannel: (s: string) => s, currentUserId: async () => null }));

import { runConnectionCheck, type CheckProbes } from "./connectionCheck";
import { normalizePairCode, isValidPairCode } from "./pairing";
import { pairFailureCopy, pairSchemaCheck, refineWrongCode, mapPairFailure, LAPTOP_ASLEEP_MESSAGE } from "./devices";
import { parseRequest } from "./agentRelay";

const NOW = 1_000_000_000;
const probes = (over: Partial<CheckProbes> = {}): CheckProbes => ({
  userId: async () => "u1",
  lastClaim: () => ({ ok: true }),
  phonePaired: async () => ({ name: "My Android phone" }),
  laptop: async () => ({ lastSeenMs: NOW - 10_000, name: "Om's laptop" }),
  realtime: async () => true,
  keys: async () => ({ llm: true, el: false }),
  ping: async () => ({ ok: true, ms: 420 }),
  now: () => NOW,
  ...over,
});

describe("connection check", () => {
  it("runs all six steps in order and reports present/missing, never key values", async () => {
    const steps = await runConnectionCheck(probes());
    expect(steps.map((s) => s.id)).toEqual(["signin", "pair", "heartbeat", "realtime", "keys", "ping"]);
    expect(steps.every((s) => s.state === "ok")).toBe(true);
    expect(steps[2].line).toMatch(/seen 10 s ago/);
    expect(steps[4].line).toBe("Planner key present.");
    expect(steps[5].line).toMatch(/420 ms/);
  });

  it("stops after 'not signed in'", async () => {
    const ping = vi.fn();
    const steps = await runConnectionCheck(probes({ userId: async () => null, ping }));
    expect(steps[0].state).toBe("fail");
    expect(steps.slice(1).every((s) => s.state === "skip")).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it("shows the real claim_pair error code and a specific fix", async () => {
    const steps = await runConnectionCheck(probes({ lastClaim: () => ({ ok: false, kind: "wrong", code: "P0002", message: "x" }), phonePaired: async () => null }));
    const pair = steps.find((s) => s.id === "pair")!;
    expect(pair.state).toBe("fail");
    expect(pair.line).toBe("Wrong code (P0002).");
    expect(pair.fix).toMatch(/8 characters/);
  });

  it("an old heartbeat says the laptop is asleep and skips the ping", async () => {
    const ping = vi.fn();
    const steps = await runConnectionCheck(probes({ laptop: async () => ({ lastSeenMs: NOW - 600_000, name: "L" }), ping }));
    const hb = steps.find((s) => s.id === "heartbeat")!;
    expect(hb.state).toBe("fail");
    expect(hb.line).toMatch(/10 min ago/);
    expect(hb.fix).toBe(LAPTOP_ASLEEP_MESSAGE);
    expect(steps.find((s) => s.id === "ping")!.state).toBe("skip");
    expect(ping).not.toHaveBeenCalled();
  });

  it("flags missing keys, a dead realtime channel and an unanswered ping", async () => {
    const steps = await runConnectionCheck(
      probes({ keys: async () => ({ llm: false, el: false }), realtime: async () => false, ping: async () => ({ ok: false, error: "Your laptop isn't answering." }) }),
    );
    expect(steps.find((s) => s.id === "keys")!.state).toBe("fail");
    expect(steps.find((s) => s.id === "realtime")!.state).toBe("fail");
    const ping = steps.find((s) => s.id === "ping")!;
    expect(ping.state).toBe("fail");
    expect(ping.fix).toMatch(/desktop app/);
  });

  it("no laptop row at all", async () => {
    const steps = await runConnectionCheck(probes({ laptop: async () => null }));
    expect(steps.find((s) => s.id === "heartbeat")!.line).toBe("No laptop on this account.");
  });
});

describe("code-only pairing", () => {
  it("accepts the code with a dash, spaces or lowercase", () => {
    expect(normalizePairCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairCode(" k7p2 qm9x ")).toBe("K7P2QM9X");
    expect(isValidPairCode("k7p2-qm9x")).toBe(true);
    expect(isValidPairCode("K7P2-QM9")).toBe(false);
  });

  it("a wrong code gets a specific message: wrong, no laptop, or no active code", () => {
    expect(mapPairFailure({ code: "P0002", message: "not active" }).kind).toBe("wrong");
    expect(mapPairFailure({ code: "P0002", message: "x" }).code).toBe("P0002");
    expect(refineWrongCode({ pair_code: "K7P2QM9X" })).toBe("wrong");
    expect(refineWrongCode(null)).toBe("no-laptop");
    expect(refineWrongCode({ pair_code: null })).toBe("no-code");
    expect(pairFailureCopy("wrong").title).toBe("Wrong code");
    expect(pairFailureCopy("no-laptop").body).toMatch(/same account/);
    expect(pairFailureCopy("expired").title).toBe("Code expired");
    expect(pairFailureCopy("not-signed-in").title).toBe("Not signed in");
  });

  it("laptop self-check: 6-char code or a constraint that rejects 8 chars shows the SQL", () => {
    expect(pairSchemaCheck("K7P2QM9X", null)).toBeNull();
    expect(pairSchemaCheck("K7P2QM", null)?.sql).toMatch(/devices_pair_code_check/);
    const w = pairSchemaCheck("K7P2QM9X", { code: "23514", message: 'violates check constraint "devices_pair_code_check"' });
    expect(w?.message).toMatch(/0004/);
    expect(w?.sql).toMatch(/\{2\}\)\?\$/);
  });

  it("the relay accepts a ping and a sane report, nothing else new", () => {
    expect(parseRequest({ op: "ping" })).toEqual({ op: "ping" });
    expect(parseRequest({ op: "report", ms: 412.6, phone: "My phone" })).toEqual({ op: "report", ms: 413, phone: "My phone" });
    expect(parseRequest({ op: "report", ms: "fast" })).toBeNull();
  });
});
