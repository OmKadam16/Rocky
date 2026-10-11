import { isNativeApp } from "./native";
/**
 * Mobile detection for routing phones to the mobile UI (/remote-style
 * calendar + talk only) instead of the desktop app. Desktop browsers —
 * even narrow windows — always keep the full app.
 */

export interface MobileSignals {
  nativeApp?: boolean;
  userAgent?: string;
  coarsePointer?: boolean;
  smallestScreenPx?: number;
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|BlackBerry|IEMobile|Opera Mini/i;

export function isMobileDevice(signals: MobileSignals = {}): boolean {
  const ua =
    signals.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (MOBILE_UA.test(ua)) return true;
  const coarse =
    signals.coarsePointer ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false);
  const smallest =
    signals.smallestScreenPx ??
    (typeof window !== "undefined" && window.screen
      ? Math.min(window.screen.width, window.screen.height)
      : Number.POSITIVE_INFINITY);
  // Touch-first small screens (phones, not tablets/desktops).
  return coarse && smallest < 768;
}

/** True when the phone UI should render: the /remote route or any phone. */
export function shouldShowMobileUi(pathname: string, signals: MobileSignals = {}): boolean {
  // The Android app is always the phone UI, whatever the screen width.
  if (signals.nativeApp ?? isNativeApp()) return true;
  if (pathname === "/remote") return true;
  return isMobileDevice(signals);
}
