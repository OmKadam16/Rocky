# Rocky Android signing key (do this ONCE)

Every Rocky APK must be signed with the same key. Android only installs an
update over an installed app when both were signed with the same key.

> **If you lose this keystore (or its passwords), installed Rocky apps can never
> be updated again. Everyone would have to uninstall (losing local data) and
> install a new app. Keep two copies: e.g. a password manager attachment and an
> offline USB drive.**

Never commit it, never paste it in chat, never put it in the repo. `.gitignore`
already ignores `*.jks` / `*.keystore`.

## 1. Create the keystore (JDK 21's `keytool`)

PowerShell, in a folder OUTSIDE the repo (for example `C:\Keys`):

```powershell
keytool -genkeypair -v -keystore rocky-release.jks -alias rocky -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12
```

It asks for a keystore password, then your name/organisation (anything), and
uses the same password for the key (PKCS12). Write the password down
in your password manager.

## 2. Add the GitHub Secrets

Repo `OmKadam16/Rocky` → Settings → Secrets and variables → Actions → New
repository secret:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore as base64 (command below) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `rocky` |
| `ANDROID_KEY_PASSWORD` | the key password (same as the keystore password for PKCS12) |

Base64 for the first one (copies it to the clipboard, prints nothing):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Keys\rocky-release.jks")) | Set-Clipboard
```

## 3. Local release build (optional)

With JDK 21 and the Android SDK installed, set these for the session (they
are read by `android/app/build.gradle`, never stored in the repo):

```powershell
$env:ROCKY_KEYSTORE_FILE = "C:\Keys\rocky-release.jks"
$env:ROCKY_KEYSTORE_PASSWORD = "<password>"
$env:ROCKY_KEY_ALIAS = "rocky"
$env:ROCKY_KEY_PASSWORD = "<password>"
npm run build:android:release
```

The APK lands in `android/app/build/outputs/apk/release/app-release.apk`.
