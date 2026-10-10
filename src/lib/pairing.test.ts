import { describe, expect, it } from "vitest";
import {
  buildPairUrl,
  extractPairFromQrText,
  formatCountdown,
  formatPairCode,
  freshPairExpiry,
  generatePairCode,
  isPairExpired,
  isValidPairCode,
  farFuturePairExpiry,
  normalizePairCode,
  parsePairParam,
  resolvePairOrigin,
  shouldReusePairCode,
} from "./pairing";

describe("pairing codes (8 Crockford chars, stored without dash)", () => {
  it("generates 8-char codes from the Crockford alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairCode();
      expect(c).toHaveLength(8);
      expect(isValidPairCode(c)).toBe(true);
      expect(c).not.toContain("-");
      expect(c).not.toMatch(/[01ILO]/);
    }
  });

  it("formats stored XXXXYYYY as XXXX-YYYY for display", () => {
    expect(formatPairCode("K7P2QMX9")).toBe("K7P2-QMX9");
  });

  it("still shows legacy 6-char codes as XXX-XXX", () => {
    expect(formatPairCode("K7P2QM")).toBe("K7P-2QM");
  });

  it("accepts codes with or without the dash", () => {
    expect(normalizePairCode("k7p2-qmx9")).toBe("K7P2QMX9");
    expect(normalizePairCode("K7P2 QMX9")).toBe("K7P2QMX9");
    expect(isValidPairCode("K7P2-QMX9")).toBe(true);
    expect(isValidPairCode("K7P2QMX9")).toBe(true);
    expect(isValidPairCode("K7P2QMX")).toBe(false);
    expect(isValidPairCode("K7P2-QMX9!")).toBe(true); // punctuation stripped
    expect(isValidPairCode("")).toBe(false);
  });

  it("still accepts legacy 6-char codes during the transition", () => {
    expect(isValidPairCode("K7P-2QM")).toBe(true);
    expect(isValidPairCode("K7P2QM")).toBe(true);
  });

  it("expires after 5 minutes", () => {
    const now = 1_000_000;
    const exp = freshPairExpiry(now);
    expect(exp - now).toBe(5 * 60 * 1000);
    expect(isPairExpired(exp, now)).toBe(false);
    expect(isPairExpired(exp, exp)).toBe(true);
    expect(isPairExpired(exp, exp + 1)).toBe(true);
  });

  it("formats countdowns as m:ss", () => {
    expect(formatCountdown(300)).toBe("5:00");
    expect(formatCountdown(61)).toBe("1:01");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});

describe("pair payload (SPA rewrite)", () => {
  it("builds https://<site>/remote?pair=<CODE> without dash", () => {
    expect(buildPairUrl("https://rocky.vercel.app", "K7P2QMX9")).toBe("https://rocky.vercel.app/remote?pair=K7P2QMX9");
    expect(buildPairUrl("https://rocky.vercel.app/", "K7P2QMX9")).toBe("https://rocky.vercel.app/remote?pair=K7P2QMX9");
  });

  it("parses ?pair= with or without dash", () => {
    expect(parsePairParam("?pair=K7P2QMX9")).toBe("K7P2QMX9");
    expect(parsePairParam("?pair=K7P2-QMX9")).toBe("K7P2QMX9");
    expect(parsePairParam("?pair=k7p2-qmx9")).toBe("K7P2QMX9");
    expect(parsePairParam("?pair=XY")).toBeNull();
    expect(parsePairParam("")).toBeNull();
  });

  it("round-trips: the built payload decodes back to the stored code", () => {
    expect(extractPairFromQrText(buildPairUrl("https://rocky-kfa8.onrender.com", "K7P2QMX9"))).toBe("K7P2QMX9");
    expect(extractPairFromQrText(buildPairUrl("https://rocky-kfa8.onrender.com/", "k7p2-qmx9"))).toBe("K7P2QMX9");
  });

  it("extracts codes from pasted text (URL or raw)", () => {
    expect(extractPairFromQrText("https://rocky.vercel.app/remote?pair=K7P2QMX9")).toBe("K7P2QMX9");
    expect(extractPairFromQrText("https://rocky.vercel.app/remote?pair=K7P2-QMX9&x=1")).toBe("K7P2QMX9");
    expect(extractPairFromQrText("K7P2-QMX9")).toBe("K7P2QMX9");
    expect(extractPairFromQrText("k7p2qmX9".toLowerCase())).toBe("K7P2QMX9");
    expect(extractPairFromQrText("hello world")).toBeNull();
    expect(extractPairFromQrText("")).toBeNull();
  });
});

describe("static pair codes (one code per user)", () => {
  it("reuses any valid existing code, generates only when absent", () => {
    expect(shouldReusePairCode("K7P2QMX9")).toBe(true);
    expect(shouldReusePairCode("k7p2-qmx9")).toBe(true);
    expect(shouldReusePairCode("K7P2QM")).toBe(true); // legacy 6-char rows
    expect(shouldReusePairCode(null)).toBe(false);
    expect(shouldReusePairCode("")).toBe(false);
    expect(shouldReusePairCode("XY")).toBe(false);
  });

  it("sets far-future expiry (~10 years)", () => {
    const now = 1_000_000;
    const exp = farFuturePairExpiry(now);
    expect(exp - now).toBeGreaterThan(9 * 365 * 24 * 3600 * 1000);
  });
});

describe("resolvePairOrigin (deployed URL for the pairing QR)", () => {
  it("prefers VITE_PUBLIC_URL when set", () => {
    expect(resolvePairOrigin("https://rocky.onrender.com", "http://localhost:8080")).toBe("https://rocky.onrender.com");
    expect(resolvePairOrigin("https://rocky.onrender.com/", "http://localhost:8080")).toBe("https://rocky.onrender.com");
  });

  it("falls back to the page origin (correct on Render)", () => {
    expect(resolvePairOrigin(undefined, "http://localhost:8080")).toBe("http://localhost:8080");
    expect(resolvePairOrigin("", "https://rocky.onrender.com/")).toBe("https://rocky.onrender.com");
  });
});
