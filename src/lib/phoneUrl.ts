/**
 * The address the phone opens to pair (the Rocky website, not the desktop
 * app's own app://rocky origin, which only exists inside Electron).
 *
 * Sources, in order:
 *   1. the "Phone site address" the user saved (profile extra
 *      `phone_site_url`, shared by all their devices) — lets a wrong baked
 *      address be fixed without a rebuild;
 *   2. VITE_PUBLIC_URL baked in at build time.
 * Only http(s) addresses are ever shown.
 */

export const PHONE_URL_FIELD = "phone_site_url";

/** A usable http(s) site address without a trailing slash, or null. */
export function cleanPhoneUrl(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export type PhoneUrlSource = "setting" | "build" | null;

export function resolvePhoneUrl(buildUrl: string | null | undefined, setting: string | null | undefined): { url: string | null; source: PhoneUrlSource } {
  const fromSetting = cleanPhoneUrl(setting);
  if (fromSetting) return { url: fromSetting, source: "setting" };
  const fromBuild = cleanPhoneUrl(buildUrl);
  if (fromBuild) return { url: fromBuild, source: "build" };
  return { url: null, source: null };
}

const PRIVATE_HOST = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** A plain-words caveat about an address the phone may not reach (null = fine). */
export function phoneUrlWarning(url: string | null): string | null {
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) {
    return "This address only works on this computer, not on your phone. Use the Rocky website address.";
  }
  if (PRIVATE_HOST.test(host)) {
    return "This is a home-network address: it works only while your phone is on the same Wi-Fi and the dev server runs, and the phone mic needs https.";
  }
  if (u.protocol === "http:") return "The phone mic needs an https address.";
  return null;
}

/** The URL baked in at build time (empty in a build without it). */
export const BUILD_PHONE_URL: string = ((import.meta.env.VITE_PUBLIC_URL as string | undefined) ?? "").trim();
