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
  normalizePairCode,
  parsePairParam,
  resolvePairOrigin,
} from "./pairing";

describe("pairing codes (6 Crockford chars, stored without dash)", () => {
  it("generates 6-char codes from the Crockford alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairCode();
      expect(c).toHaveLength(6);
      expect(isValidPairCode(c)).toBe(true);
      expect(c).not.toContain("-");
      expect(c).not.toMatch(/[01ILO]/);
    }
  });

  it("formats stored XXXYYY as XXX-XXX for display", () => {
    expect(formatPairCode("K7P2QM")).toBe("K7P-2QM");
  });

  it("accepts codes with or without the dash", () => {
    expect(normalizePairCode("k7p-2qm")).toBe("K7P2QM");
    expect(normalizePairCode("K7P 2QM")).toBe("K7P2QM");
    expect(isValidPairCode("K7P-2QM")).toBe(true);
    expect(isValidPairCode("K7P2QM")).toBe(true);
    expect(isValidPairCode("K7P2Q")).toBe(false);
    expect(isValidPairCode("K7P-2QM!")).toBe(true); // punctuation stripped
    expect(isValidPairCode("")).toBe(false);
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

describe("QR payload (SPA rewrite)", () => {
  it("builds https://<site>/remote?pair=<CODE> without dash", () => {
    expect(buildPairUrl("https://rocky.vercel.app", "K7P2QM")).toBe("https://rocky.vercel.app/remote?pair=K7P2QM");
    expect(buildPairUrl("https://rocky.vercel.app/", "K7P2QM")).toBe("https://rocky.vercel.app/remote?pair=K7P2QM");
  });

  it("parses ?pair= with or without dash", () => {
    expect(parsePairParam("?pair=K7P2QM")).toBe("K7P2QM");
    expect(parsePairParam("?pair=K7P-2QM")).toBe("K7P2QM");
    expect(parsePairParam("?pair=k7p-2qm")).toBe("K7P2QM");
    expect(parsePairParam("?pair=XY")).toBeNull();
    expect(parsePairParam("")).toBeNull();
  });

  it("extracts codes from scanned QR text (URL or raw)", () => {
    expect(extractPairFromQrText("https://rocky.vercel.app/remote?pair=K7P2QM")).toBe("K7P2QM");
    expect(extractPairFromQrText("https://rocky.vercel.app/remote?pair=K7P-2QM&x=1")).toBe("K7P2QM");
    expect(extractPairFromQrText("K7P-2QM")).toBe("K7P2QM");
    expect(extractPairFromQrText("k7p2qm")).toBe("K7P2QM");
    expect(extractPairFromQrText("hello world")).toBeNull();
    expect(extractPairFromQrText("")).toBeNull();
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
