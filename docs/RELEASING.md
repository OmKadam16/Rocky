# Releasing Rocky (desktop + Android)

Version: one source of truth, `package.json` `"version"` (x.y.z, minor and
patch 0-99). It feeds the web bundle (`__APP_VERSION__`), the desktop app,
Android `versionName` and `versionCode` (= x*10000 + y*100 + z).

## One-time setup

1. **Two public, releases-only repos** (github.com/new, Public, "Add a README"):
   - `OmKadam16/rocky-releases` (Windows installers + `latest.yml`)
   - `OmKadam16/rocky-android-releases` (APK + `dist.zip` + `android-update.json`)
   Each needs at least one commit (the README) so releases can be tagged.
   Apps download updates from them without logging in. The source repo can
   stay as it is.
2. **Token** `RELEASES_REPO_TOKEN`: github.com → Settings → Developer settings
   → Fine-grained tokens → Generate. Repository access: only
   `rocky-releases` and `rocky-android-releases`. Permissions: Contents → Read
   and write. Add it as an Actions secret in `OmKadam16/Rocky`.
3. **Build secrets** in `OmKadam16/Rocky` (Actions secrets): `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_URL` (the same values as `.env.local`).
4. **Android signing**: `scripts/android-keystore.md` (once!).
5. **Supabase** → Authentication → URL Configuration → Redirect URLs: add
   `com.rocky.calendar.android://auth` (email confirm / reset links open the
   app again).

## Desktop (Windows) release

```bash
npm version patch --no-git-tag-version
git commit -am "release $(node -p "require('./package.json').version")"
git tag v$(node -p "require('./package.json').version")
git push && git push --tags
```

`.github/workflows/release-desktop.yml` builds the NSIS installer and publishes
it with `latest.yml` and the blockmap to `rocky-releases`. Installed apps check
on start and every 6 hours (Profile → Rocky, on by default), download in the
background and ask before restarting. Builds aren't code-signed: SmartScreen
may warn on a fresh install ("More info → Run anyway"); in-app updates don't
need signing. After the FIRST release is out, set `UPDATES_ENABLED = true` in
`src/lib/features.ts` and release again.

## Android release

```bash
git tag android-v$(node -p "require('./package.json').version")
git push --tags
```

`.github/workflows/release-android.yml` builds the web bundle and the signed
APK, writes `android-update.json` (SHA-256 + sizes) and publishes all three to
`rocky-android-releases`. Phones check on start and when coming back to the
foreground (at most every 6 hours):

- **Web-only change** (most releases): the phone downloads `dist.zip`, checks
  its SHA-256, and switches on the next launch. If the new bundle doesn't start
  within 10 s it rolls back to the previous one and never retries that version.
  It shows "Updated to x.y.z" once.
- **Native change** (a plugin, Kotlin, permissions, Capacitor): bump
  `package.json` → `"rocky": { "androidMinNative": "<this version>" }` before
  tagging. Older APKs then skip the web bundle and show "Update available
  (x.y.z, N MB)"; tapping Update downloads the APK (SHA-256 checked) and opens
  Android's installer. The user taps Install (and, the first time, allows
  installs from Rocky). This is never silent.

A desktop and an Android release can share a version: push both tags.

## Debug APK

Every push to `main` that touches the app builds a debug APK
(`.github/workflows/android-build.yml`, artifact `rocky-debug-apk`). Locally:
JDK 21 + Android SDK, then `npm run build:android` →
`android/app/build/outputs/apk/debug/app-debug.apk`. The debug app is
`com.rocky.calendar.android.debug`, so it installs next to the release app.

## Setting secrets safely (Windows)
Windows PowerShell 5.1 adds a UTF-8 BOM (and CRLF) to anything piped into a
program, so `"value" | gh secret set NAME` stores a broken secret. That is
how the Supabase URL and key once reached the APK with a BOM ("non
ISO-8859-1 code point" at sign-in). Instead, write the value to a file with no
BOM and no newline, then `gh secret set NAME -R OmKadam16/Rocky < file` from
cmd or bash (or paste it in GitHub's web form), and delete the file. Every
workflow runs `scripts/check-build-env.mjs` first and stops with the secret's
NAME (never its value) if one is empty, non-ASCII or has spaces around it.
