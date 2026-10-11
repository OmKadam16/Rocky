/**
 * Android updates, decided in code (pure; tested in appUpdate.test.ts).
 *
 * One manifest per release, android-update.json, in the public releases repo
 * OmKadam16/rocky-android-releases:
 *   {
 *     "schema": 1,
 *     "version": "0.1.15",            web bundle version (= package.json)
 *     "minNativeVersion": "0.1.14",   the bundle needs at least this APK
 *     "nativeVersion": "0.1.15",      the APK in this release
 *     "web": { "url", "sha256", "size" },   dist.zip
 *     "apk": { "url", "sha256", "size" },   rocky-0.1.15.apk
 *     "notes": "…"
 *   }
 * Rules: only https URLs inside the releases repo; a web bundle only when
 * the installed app is new enough for it; never a version that already
 * failed to boot (it was rolled back); at most one check per 6 hours.
 */

export const RELEASES_REPO = "OmKadam16/rocky-android-releases";
export const MANIFEST_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download/android-update.json`;
const ASSET_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type Asset = { url: string; sha256: string; size: number };
export type UpdateManifest = {
  schema: 1;
  version: string;
  minNativeVersion: string;
  nativeVersion: string;
  web: Asset;
  apk: Asset;
  notes?: string;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1 / 0 / 1 for x.y.z strings (anything after a "-" is ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(String(a).split("-")[0].trim());
  const pb = SEMVER.exec(String(b).split("-")[0].trim());
  if (!pa || !pb) throw new Error(`Not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const isVersion = (v: unknown): v is string => typeof v === "string" && SEMVER.test(v);

function validAsset(a: unknown, ext: string): a is Asset {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.url === "string" &&
    x.url.startsWith(ASSET_PREFIX) &&
    x.url.endsWith(ext) &&
    !x.url.includes("..") &&
    typeof x.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(x.sha256) &&
    typeof x.size === "number" &&
    x.size > 0 &&
    x.size < 300 * 1024 * 1024
  );
}

/** A manifest we may act on, or null. Anything odd is ignored, never "fixed". */
export function validateManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.schema !== 1) return null;
  if (!isVersion(m.version) || !isVersion(m.minNativeVersion) || !isVersion(m.nativeVersion)) return null;
  if (!validAsset(m.web, ".zip") || !validAsset(m.apk, ".apk")) return null;
  return {
    schema: 1,
    version: m.version,
    minNativeVersion: m.minNativeVersion,
    nativeVersion: m.nativeVersion,
    web: m.web,
    apk: m.apk,
    notes: typeof m.notes === "string" ? m.notes.slice(0, 500) : undefined,
  };
}

export type UpdatePlan = {
  /** Download this web bundle (SHA-256 checked) and switch to it on next launch. */
  web: { version: string; asset: Asset } | null;
  /** A newer APK exists: show the card (the user installs it). */
  native: { version: string; asset: Asset } | null;
  /** Why no web update, for the debug line. */
  reason: "none" | "web" | "incompatible" | "failed-before" | "up-to-date";
};

export function planUpdate(p: { manifest: UpdateManifest; nativeVersion: string; bundleVersion: string; failedVersions?: string[] }): UpdatePlan {
  const { manifest: m } = p;
  const native = compareVersions(m.nativeVersion, p.nativeVersion) > 0 ? { version: m.nativeVersion, asset: m.apk } : null;
  if (compareVersions(m.version, p.bundleVersion) <= 0) return { web: null, native, reason: native ? "none" : "up-to-date" };
  if (compareVersions(p.nativeVersion, m.minNativeVersion) < 0) return { web: null, native, reason: "incompatible" };
  if ((p.failedVersions ?? []).includes(m.version)) return { web: null, native, reason: "failed-before" };
  return { web: { version: m.version, asset: m.web }, native, reason: "web" };
}

/** At most one check per 6 hours (a forced check from the button skips this). */
export function shouldCheck(lastCheckMs: number | null, now: number, force = false): boolean {
  return force || lastCheckMs == null || now - lastCheckMs >= CHECK_EVERY_MS;
}

/** "Updated to x.y.z" once: when the running bundle differs from the last one seen. */
export function updatedNotice(runningVersion: string, lastSeenVersion: string | null): string | null {
  if (!lastSeenVersion || lastSeenVersion === runningVersion) return null;
  try {
    return compareVersions(runningVersion, lastSeenVersion) > 0 ? `Updated to ${runningVersion}` : null;
  } catch {
    return null;
  }
}

export const formatSize = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
