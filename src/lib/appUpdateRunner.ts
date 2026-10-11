/**
 * Runs the Android update check (the decisions are in appUpdate.ts). All
 * platform calls are injected, so the paths are tested without a phone
 * (appUpdate.test.ts); appUpdateNative.ts binds them to the plugins.
 */
import { planUpdate, shouldCheck, validateManifest, type Asset, type UpdatePlan } from "./appUpdate";

export type KeyValue = { get(key: string): string | null; set(key: string, value: string): void };

export type UpdaterDeps = {
  /** The manifest JSON; throws on a network error. */
  fetchManifest: () => Promise<unknown>;
  /** Installed APK version (versionName). */
  nativeVersion: () => Promise<string>;
  /** Version of the web bundle that is running now. */
  bundleVersion: string;
  /** Download a web bundle; the updater checks SHA-256 and throws on mismatch. */
  downloadBundle: (asset: Asset, version: string) => Promise<{ id: string }>;
  /** Use that bundle from the next launch (the current one stays for rollback). */
  scheduleBundle: (id: string) => Promise<void>;
  storage: KeyValue;
  now: () => number;
};

export const KEYS = {
  lastCheck: "rocky-update-last-check",
  failed: "rocky-update-failed",
  scheduled: "rocky-update-scheduled",
  lastSeen: "rocky-update-last-seen",
} as const;

export type CheckResult =
  | { status: "skipped" }
  | { status: "no-update"; plan: UpdatePlan | null }
  | { status: "web-scheduled"; plan: UpdatePlan }
  | { status: "native-available"; plan: UpdatePlan }
  | { status: "error"; error: string };

const readFailed = (s: KeyValue): string[] => {
  try {
    const v = JSON.parse(s.get(KEYS.failed) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** A bundle failed to boot and was rolled back: never try that version again. */
export function recordFailedBundle(storage: KeyValue, version: string): void {
  const list = readFailed(storage);
  if (!list.includes(version)) storage.set(KEYS.failed, JSON.stringify([...list, version].slice(-10)));
}

export async function runUpdateCheck(deps: UpdaterDeps, opts: { force?: boolean } = {}): Promise<CheckResult> {
  const last = Number(deps.storage.get(KEYS.lastCheck) ?? "") || null;
  if (!shouldCheck(last, deps.now(), opts.force)) return { status: "skipped" };
  let raw: unknown;
  try {
    raw = await deps.fetchManifest();
  } catch (e) {
    // Network trouble: try again next time, no throttle stamp.
    return { status: "error", error: `Couldn't check for updates (${e instanceof Error ? e.message : String(e)}).` };
  }
  deps.storage.set(KEYS.lastCheck, String(deps.now()));
  if (raw == null) return { status: "no-update", plan: null }; // no release published yet
  const manifest = validateManifest(raw);
  if (!manifest) return { status: "error", error: "The update manifest wasn't valid; nothing was changed." };
  const plan = planUpdate({ manifest, nativeVersion: await deps.nativeVersion(), bundleVersion: deps.bundleVersion, failedVersions: readFailed(deps.storage) });
  if (plan.web && deps.storage.get(KEYS.scheduled) !== plan.web.version) {
    try {
      const bundle = await deps.downloadBundle(plan.web.asset, plan.web.version);
      await deps.scheduleBundle(bundle.id);
      deps.storage.set(KEYS.scheduled, plan.web.version);
      return { status: "web-scheduled", plan };
    } catch (e) {
      // Bad checksum or a broken download: nothing is installed or run.
      return { status: "error", error: `The update didn't verify, so it wasn't installed (${e instanceof Error ? e.message : String(e)}).` };
    }
  }
  if (plan.native) return { status: "native-available", plan };
  return { status: "no-update", plan };
}

export type ApkDeps = {
  download: (asset: Asset, version: string) => Promise<{ path: string }>;
  install: (path: string) => Promise<{ needsPermission: boolean }>;
};

/** Native APK update: download (SHA-256 checked natively), then Android's installer. */
export async function downloadAndInstallApk(deps: ApkDeps, asset: Asset, version: string): Promise<{ ok: boolean; message: string }> {
  let path: string;
  try {
    path = (await deps.download(asset, version)).path;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return { ok: false, message: code === "hash_mismatch" ? "The download didn't match its checksum, so nothing was installed. Try again later." : "The download failed. Check your connection and try again." };
  }
  const r = await deps.install(path).catch(() => null);
  if (!r) return { ok: false, message: "Android couldn't open the installer." };
  if (r.needsPermission) return { ok: false, message: "Allow installs from Rocky in the screen that just opened, then tap Update again." };
  return { ok: true, message: "Android will ask you to tap Install." };
}
