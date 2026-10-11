/**
 * The Android app (Capacitor shell) vs the browser and the desktop app.
 * Everything native goes through here so the web and desktop builds never
 * need the native plugins at runtime.
 */
import { Capacitor } from "@capacitor/core";

/** True inside the Rocky Android app. */
export const isNativeApp = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** Where Supabase email links (confirm, reset) come back to. */
export const NATIVE_AUTH_REDIRECT = "com.rocky.calendar.android://auth";

/** Redirect for Supabase emails: the app's deep link in the app, the site elsewhere. */
export function authRedirectUrl(origin: string = typeof window !== "undefined" ? window.location.origin : ""): string {
  return isNativeApp() ? NATIVE_AUTH_REDIRECT : origin;
}

/** The PKCE `code` from a deep link like com.rocky.calendar.android://auth?code=… (or null). */
export function authCodeFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!url.startsWith(NATIVE_AUTH_REDIRECT)) return null;
    const code = u.searchParams.get("code");
    return code && /^[A-Za-z0-9._~-]{8,}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Supabase session storage in the app: Android Keystore-backed (secure
 * storage plugin), not the WebView's localStorage. Loaded lazily so web
 * builds never touch it.
 */
export function secureAuthStorage() {
  const plugin = () => import("@aparajita/capacitor-secure-storage").then((m) => m.SecureStorage);
  return {
    getItem: async (key: string) => (await plugin()).getItem(key),
    setItem: async (key: string, value: string) => (await plugin()).setItem(key, value),
    removeItem: async (key: string) => (await plugin()).removeItem(key),
  };
}
