import { describe, expect, it } from "vitest";
import { isMobileDevice, shouldShowMobileUi } from "./isMobile";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("isMobileDevice", () => {
  it("detects Android and iPhone user agents", () => {
    expect(isMobileDevice({ userAgent: ANDROID_UA })).toBe(true);
    expect(isMobileDevice({ userAgent: IPHONE_UA })).toBe(true);
  });

  it("keeps desktop browsers on the full app, even narrow ones", () => {
    expect(isMobileDevice({ userAgent: DESKTOP_UA, coarsePointer: false, smallestScreenPx: 390 })).toBe(false);
    expect(isMobileDevice({ userAgent: DESKTOP_UA })).toBe(false);
  });

  it("treats small touch-first screens as phones", () => {
    expect(isMobileDevice({ userAgent: "SomeBrowser/1.0", coarsePointer: true, smallestScreenPx: 390 })).toBe(true);
    expect(isMobileDevice({ userAgent: "SomeBrowser/1.0", coarsePointer: true, smallestScreenPx: 1024 })).toBe(false);
  });
});

describe("shouldShowMobileUi", () => {
  it("always shows mobile UI on /remote", () => {
    expect(shouldShowMobileUi("/remote", { userAgent: DESKTOP_UA })).toBe(true);
  });

  it("shows mobile UI to phones on any path (QR or typed root URL)", () => {
    expect(shouldShowMobileUi("/", { userAgent: ANDROID_UA })).toBe(true);
    expect(shouldShowMobileUi("/", { userAgent: IPHONE_UA })).toBe(true);
  });

  it("keeps the desktop app for laptop browsers", () => {
    expect(shouldShowMobileUi("/", { userAgent: DESKTOP_UA })).toBe(false);
  });
});
