#!/bin/bash
# Builds ~/Applications/LearnHarness.app (icon + launcher), like Factory.app. Re-run after changing
# the launcher.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HOME/Applications/LearnHarness.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/learnharness-launcher.sh" "$APP/Contents/MacOS/LearnHarness"; chmod +x "$APP/Contents/MacOS/LearnHarness"
cp "$HERE/../../build/icon.icns" "$APP/Contents/Resources/LearnHarness.icns"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>LearnHarness</string>
  <key>CFBundleDisplayName</key><string>LearnHarness</string>
  <key>CFBundleIdentifier</key><string>com.allgravy.learnharness</string>
  <key>CFBundleExecutable</key><string>LearnHarness</string>
  <key>CFBundleIconFile</key><string>LearnHarness</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
touch "$APP"
echo "built $APP"
