/**
 * Android update plumbing: binds appUpdateRunner to the plugins.
 *   - web bundles: @capgo/capacitor-updater in manual mode (no capgo cloud,
 *     SHA-256 checked, applied on next launch, automatic rollback when the
 *     new bundle doesn't call notifyAppReady within 10 s);
 *   - APKs: RockyApkUpdater (android/…/RockyApkUpdaterPlugin.kt).
 * Only ever imported from the Android shell (dynamic import), never on web.
 */
import { CapacitorHttp, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import { MANIFEST_URL, updatedNotice, type Asset } from "./appUpdate";
import { downloadAndInstallApk, KEYS, recordFailedBundle, runUpdateCheck, type CheckResult, type KeyValue, type UpdaterDeps } from "./appUpdateRunner";

type ApkPlugin = {
  download(o: { url: string; sha256: string; version: string }): Promise<{ path: string; size: number }>;
  install(o: { path: string }): Promise<{ needsPermission: boolean }>;
};
const RockyApkUpdater = registerPlugin<ApkPlugin>("RockyApkUpdater");

const storage: KeyValue = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  },
};

const deps: UpdaterDeps = {
  fetchManifest: async () => {
    // Native HTTP: GitHub's release downloads send no CORS headers.
    const r = await CapacitorHttp.get({ url: MANIFEST_URL, responseType: "json", connectTimeout: 15000, readTimeout: 15000 });
    if (r.status === 404) return null; // no release yet
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  },
  nativeVersion: async () => (await App.getInfo()).version,
  bundleVersion: __APP_VERSION__,
  downloadBundle: async (asset: Asset, version: string) => CapacitorUpdater.download({ url: asset.url, version, checksum: asset.sha256 }),
  scheduleBundle: async (id: string) => {
    await CapacitorUpdater.next({ id });
  },
  storage,
  now: () => Date.now(),
};

export type NativeUpdateState = { notice: string | null; native: { version: string; asset: Asset } | null; last: CheckResult | null };
let state: NativeUpdateState = { notice: null, native: null, last: null };
const listeners = new Set<(s: NativeUpdateState) => void>();
const set = (patch: Partial<NativeUpdateState>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
};
export const getUpdateState = () => state;
export function onUpdateState(fn: (s: NativeUpdateState) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export async function checkNow(force = false): Promise<CheckResult> {
  const r = await runUpdateCheck(deps, { force });
  set({ last: r, native: r.status !== "skipped" && r.status !== "error" ? (r.plan?.native ?? null) : state.native });
  return r;
}

export function installApk(asset: Asset, version: string) {
  return downloadAndInstallApk(
    {
      download: (a, v) => RockyApkUpdater.download({ url: a.url, sha256: a.sha256, version: v }),
      install: (path) => RockyApkUpdater.install({ path }),
    },
    asset,
    version,
  );
}

/**
 * App start (once): confirm this bundle booted (or the updater rolls it
 * back), remember a version that failed, say "Updated to x.y.z" once, then
 * check now and whenever the app comes back to the foreground (6 h throttle).
 */
export async function startNativeUpdates(): Promise<void> {
  await CapacitorUpdater.notifyAppReady().catch(() => {});
  const failed = await CapacitorUpdater.getFailedUpdate().catch(() => null);
  if (failed?.bundle?.version) recordFailedBundle(storage, failed.bundle.version);
  void CapacitorUpdater.addListener("updateFailed", (e) => {
    if (e?.bundle?.version) recordFailedBundle(storage, e.bundle.version);
  });
  set({ notice: updatedNotice(__APP_VERSION__, storage.get(KEYS.lastSeen)) });
  storage.set(KEYS.lastSeen, __APP_VERSION__);
  void checkNow().catch(() => {});
  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) void checkNow().catch(() => {});
  });
}

export function dismissNotice() {
  set({ notice: null });
}
