// Release files for OmKadam16/rocky-android-releases (used by
// .github/workflows/release-android.yml):
//   node scripts/android-release-files.mjs <signed.apk> <dist.zip> <outDir>
// Writes <outDir>/rocky-<version>.apk, dist.zip and android-update.json
// (format and rules: src/lib/appUpdate.ts). minNativeVersion comes from
// package.json "rocky.androidMinNative": bump it whenever native code or a
// native plugin changes, so old APKs never get a web bundle they can't run.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [apkIn, zipIn, out] = process.argv.slice(2);
if (!apkIn || !zipIn || !out) {
  console.error("usage: android-release-files.mjs <apk> <dist.zip> <outDir>");
  process.exit(1);
}
const root = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const minNative = pkg.rocky?.androidMinNative ?? version;
const repo = "OmKadam16/rocky-android-releases";
const tag = `android-v${version}`;
const base = `https://github.com/${repo}/releases/download/${tag}`;

fs.mkdirSync(out, { recursive: true });
const apkName = `rocky-${version}.apk`;
fs.copyFileSync(apkIn, path.join(out, apkName));
fs.copyFileSync(zipIn, path.join(out, "dist.zip"));
const info = (f) => {
  const buf = fs.readFileSync(path.join(out, f));
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), size: buf.length };
};
const manifest = {
  schema: 1,
  version,
  minNativeVersion: minNative,
  nativeVersion: version,
  web: { url: `${base}/dist.zip`, ...info("dist.zip") },
  apk: { url: `${base}/${apkName}`, ...info(apkName) },
  notes: process.env.RELEASE_NOTES || `Rocky ${version}`,
};
fs.writeFileSync(path.join(out, "android-update.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
