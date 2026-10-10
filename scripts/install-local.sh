#!/usr/bin/env bash
#
# Put the freshly built app into /Applications.
#
# Copying it there directly, rather than opening the DMG, is deliberate: macOS
# only attaches the com.apple.quarantine flag to *downloaded* files, so a local
# copy of an unsigned build opens with no Gatekeeper warning.
#
# Usage: npm run install:app   (builds first)
#        scripts/install-local.sh   (installs whatever was last built)

set -euo pipefail

APP="release/mac-arm64/Rocky.app"
DEST="/Applications/Rocky.app"

if [ ! -d "$APP" ]; then
  echo "No build found at $APP — run 'npm run build:mac' first." >&2
  exit 1
fi

# Quit politely, then make sure it is really gone before replacing it.
osascript -e 'tell application "Rocky" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5; do
  pgrep -f "$DEST/Contents/MacOS/Rocky" >/dev/null 2>&1 || break
  sleep 1
done
pkill -f "$DEST/Contents/MacOS/Rocky" >/dev/null 2>&1 || true

rm -rf "$DEST"
cp -R "$APP" "$DEST"

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist")
echo "Installed Rocky $VERSION to $DEST"
open -a "$DEST"
