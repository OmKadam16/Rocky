// Android build: the web bundle (CAPACITOR=1), `cap sync`, then Gradle.
//
//   npm run build:android            debug APK  (debug-signed, quick installs)
//   npm run build:android:release    release APK (signed with the Rocky keystore
//                                    from ROCKY_KEYSTORE_* env vars; see
//                                    scripts/android-keystore.md)
//   node scripts/build-android.mjs web   only the web bundle + cap sync (CI)
//
// Needs JDK 21 and the Android SDK (ANDROID_HOME, or sdk.dir in
// android/local.properties). GitHub Actions has both: .github/workflows.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] ?? "debug";
const root = path.join(import.meta.dirname, "..");
const win = process.platform === "win32";
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: win, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const env = { ...process.env, CAPACITOR: "1" };
if (!env.VITE_SUPABASE_URL && !fs.existsSync(path.join(root, ".env.local"))) {
  console.warn("\n[rocky] WARNING: no VITE_SUPABASE_URL / .env.local: this APK runs without an account (it can't pair).\n");
}
run("npx", ["tsc", "-b"], { env, cwd: root });
run("npx", ["vite", "build"], { env, cwd: root });
run("npx", ["cap", "sync", "android"], { env, cwd: root });
if (mode === "web") process.exit(0);

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const localProps = path.join(root, "android", "local.properties");
if (!sdk && !fs.existsSync(localProps)) {
  console.error("\n[rocky] No Android SDK found. Set ANDROID_HOME (or sdk.dir in android/local.properties), or build in GitHub Actions (.github/workflows/android-build.yml).\n");
  process.exit(1);
}
const task = mode === "release" ? "assembleRelease" : "assembleDebug";
run(win ? "gradlew.bat" : "./gradlew", [task, "--no-daemon"], { cwd: path.join(root, "android") });

const dir = path.join(root, "android", "app", "build", "outputs", "apk", mode === "release" ? "release" : "debug");
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".apk"))) {
  const p = path.join(dir, f);
  console.log(`[rocky] APK: ${path.relative(root, p)} (${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB)`);
}
