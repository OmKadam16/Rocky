import { describe, expect, it } from "vitest";
import { compareVersions, planUpdate, shouldCheck, updatedNotice, validateManifest, CHECK_EVERY_MS, type UpdateManifest } from "./appUpdate";
import { downloadAndInstallApk, KEYS, recordFailedBundle, runUpdateCheck, type KeyValue, type UpdaterDeps } from "./appUpdateRunner";
import { authCodeFromUrl, NATIVE_AUTH_REDIRECT } from "./native";
import { backAction } from "./phoneTabs";

const DL = "https://github.com/OmKadam16/rocky-android-releases/releases/download/android-v0.1.15";
const SHA = "a".repeat(64);
const manifest = (over: Partial<UpdateManifest> = {}): UpdateManifest => ({
  schema: 1,
  version: "0.1.15",
  minNativeVersion: "0.1.14",
  nativeVersion: "0.1.14",
  web: { url: `${DL}/dist.zip`, sha256: SHA, size: 2_000_000 },
  apk: { url: `${DL}/rocky-0.1.14.apk`, sha256: "b".repeat(64), size: 9_000_000 },
  ...over,
});

const mem = (): KeyValue & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

const deps = (over: Partial<UpdaterDeps> = {}): UpdaterDeps & { downloads: string[]; scheduled: string[] } => {
  const downloads: string[] = [];
  const scheduled: string[] = [];
  return {
    downloads,
    scheduled,
    fetchManifest: async () => manifest(),
    nativeVersion: async () => "0.1.14",
    bundleVersion: "0.1.14",
    downloadBundle: async (_a, v) => (downloads.push(v), { id: `b-${v}` }),
    scheduleBundle: async (id) => void scheduled.push(id),
    storage: mem(),
    now: () => 1_000_000_000,
    ...over,
  };
};

describe("version comparison", () => {
  it("compares x.y.z numerically, ignores suffixes, rejects junk", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.1.14", "0.1.14-debug")).toBe(0);
    expect(compareVersions("0.1.3", "0.2.0")).toBe(-1);
    expect(() => compareVersions("1.2", "1.2.0")).toThrow();
  });
});

describe("manifest validation", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifest())).not.toBeNull();
  });
  it("rejects files outside the releases repo, non-https, bad hashes, wrong types", () => {
    expect(validateManifest(manifest({ web: { url: "https://evil.example/dist.zip", sha256: SHA, size: 1 } }))).toBeNull();
    expect(validateManifest(manifest({ web: { url: `${DL.replace("https", "http")}/dist.zip`, sha256: SHA, size: 1 } }))).toBeNull();
    expect(validateManifest(manifest({ apk: { url: `${DL}/rocky.apk`, sha256: "XYZ", size: 1 } }))).toBeNull();
    expect(validateManifest(manifest({ web: { url: `${DL}/../x/dist.zip`, sha256: SHA, size: 1 } }))).toBeNull();
    expect(validateManifest({ ...manifest(), schema: 2 })).toBeNull();
    expect(validateManifest({ ...manifest(), version: "latest" })).toBeNull();
    expect(validateManifest(null)).toBeNull();
  });
});

describe("what to update", () => {
  it("a newer web bundle compatible with this APK is downloaded and scheduled", () => {
    const p = planUpdate({ manifest: manifest(), nativeVersion: "0.1.14", bundleVersion: "0.1.14" });
    expect(p.web?.version).toBe("0.1.15");
    expect(p.native).toBeNull();
  });
  it("compatibility gating: a bundle that needs a newer APK is not applied; the APK card shows", () => {
    const p = planUpdate({ manifest: manifest({ minNativeVersion: "0.1.15", nativeVersion: "0.1.15", apk: { url: `${DL}/rocky-0.1.15.apk`, sha256: SHA, size: 9e6 } }), nativeVersion: "0.1.14", bundleVersion: "0.1.14" });
    expect(p.web).toBeNull();
    expect(p.reason).toBe("incompatible");
    expect(p.native?.version).toBe("0.1.15");
  });
  it("rollback: a version that failed to boot is never tried again", () => {
    const s = mem();
    recordFailedBundle(s, "0.1.15");
    recordFailedBundle(s, "0.1.15");
    expect(JSON.parse(s.get(KEYS.failed)!)).toEqual(["0.1.15"]);
    const p = planUpdate({ manifest: manifest(), nativeVersion: "0.1.14", bundleVersion: "0.1.14", failedVersions: ["0.1.15"] });
    expect(p.web).toBeNull();
    expect(p.reason).toBe("failed-before");
  });
  it("up to date: nothing", () => {
    const p = planUpdate({ manifest: manifest({ version: "0.1.14" }), nativeVersion: "0.1.14", bundleVersion: "0.1.14" });
    expect(p).toEqual({ web: null, native: null, reason: "up-to-date" });
  });
  it("checks at most every 6 hours unless forced", () => {
    expect(shouldCheck(null, 10)).toBe(true);
    expect(shouldCheck(0, CHECK_EVERY_MS - 1)).toBe(false);
    expect(shouldCheck(0, CHECK_EVERY_MS)).toBe(true);
    expect(shouldCheck(0, 1, true)).toBe(true);
  });
  it("'Updated to x.y.z' shows once, only for a newer version", () => {
    expect(updatedNotice("0.1.15", "0.1.14")).toBe("Updated to 0.1.15");
    expect(updatedNotice("0.1.15", "0.1.15")).toBeNull();
    expect(updatedNotice("0.1.15", null)).toBeNull();
    expect(updatedNotice("0.1.14", "0.1.15")).toBeNull(); // a rollback isn't an update
  });
});

describe("the update check", () => {
  it("schedules a verified web bundle once, then stays quiet", async () => {
    const d = deps();
    expect((await runUpdateCheck(d)).status).toBe("web-scheduled");
    expect(d.scheduled).toEqual(["b-0.1.15"]);
    expect((await runUpdateCheck(d, { force: true })).status).toBe("no-update");
    expect(d.downloads).toEqual(["0.1.15"]);
  });
  it("no update: nothing downloaded", async () => {
    const d = deps({ fetchManifest: async () => manifest({ version: "0.1.14" }) });
    expect((await runUpdateCheck(d)).status).toBe("no-update");
    expect(d.downloads).toEqual([]);
  });
  it("no release published yet (404) counts as no update", async () => {
    const d = deps({ fetchManifest: async () => null });
    expect((await runUpdateCheck(d)).status).toBe("no-update");
  });
  it("network error: reported, nothing changes, and the next start tries again", async () => {
    const d = deps({ fetchManifest: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const r = await runUpdateCheck(d);
    expect(r.status).toBe("error");
    expect(d.storage.get(KEYS.lastCheck)).toBeNull();
  });
  it("hash verification failure: the bundle is never scheduled", async () => {
    const d = deps({ downloadBundle: async () => Promise.reject(Object.assign(new Error("checksum_failed"), { code: "checksum" })) });
    const r = await runUpdateCheck(d);
    expect(r.status).toBe("error");
    expect(d.scheduled).toEqual([]);
    expect(d.storage.get(KEYS.scheduled)).toBeNull();
  });
  it("an invalid manifest changes nothing", async () => {
    const d = deps({ fetchManifest: async () => ({ schema: 1, version: "x" }) });
    expect((await runUpdateCheck(d)).status).toBe("error");
    expect(d.downloads).toEqual([]);
  });
  it("a newer APK shows the card", async () => {
    const d = deps({ fetchManifest: async () => manifest({ version: "0.1.14", nativeVersion: "0.1.16" }) });
    const r = await runUpdateCheck(d);
    expect(r.status).toBe("native-available");
  });
});

describe("APK install", () => {
  const asset = manifest().apk;
  it("a checksum mismatch installs nothing", async () => {
    let installed = false;
    const r = await downloadAndInstallApk(
      { download: async () => Promise.reject({ code: "hash_mismatch" }), install: async () => ((installed = true), { needsPermission: false }) },
      asset,
      "0.1.16",
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/checksum/);
    expect(installed).toBe(false);
  });
  it("first time: Android's 'install unknown apps' screen", async () => {
    const r = await downloadAndInstallApk({ download: async () => ({ path: "/x.apk" }), install: async () => ({ needsPermission: true }) }, asset, "0.1.16");
    expect(r.message).toMatch(/Allow installs from Rocky/);
  });
  it("then Android's installer asks the user to tap Install", async () => {
    const r = await downloadAndInstallApk({ download: async () => ({ path: "/x.apk" }), install: async () => ({ needsPermission: false }) }, asset, "0.1.16");
    expect(r).toEqual({ ok: true, message: "Android will ask you to tap Install." });
  });
});

describe("Android shell", () => {
  it("Back: settings sheet, then Chat -> Calendar, then exit", () => {
    expect(backAction({ tab: "chat", settingsOpen: true })).toBe("close-settings");
    expect(backAction({ tab: "chat", settingsOpen: false })).toBe("to-calendar");
    expect(backAction({ tab: "calendar", settingsOpen: false })).toBe("exit");
  });
  it("only the app's own auth deep link yields a sign-in code", () => {
    expect(authCodeFromUrl(`${NATIVE_AUTH_REDIRECT}?code=abc123def456`)).toBe("abc123def456");
    expect(authCodeFromUrl("https://evil.example/auth?code=abc123def456")).toBeNull();
    expect(authCodeFromUrl(`${NATIVE_AUTH_REDIRECT}?code=<script>`)).toBeNull();
  });
});
