#!/usr/bin/env bash
# Curate a small set of authentic Windows XP icons from the downloaded high-res
# pack into public/xp/, resized to sane sizes (the source PNGs are 1024²/256K+).
# Start-menu icons render ~22px, so 44px stays crisp on retina; message-box icons
# render ~48px, so 96px is plenty. Keeps the repo small while looking authentic.
set -euo pipefail

SRC="/Users/chris/Downloads/Windows XP High Resolution Icon Pack/Windows XP Icons"
OUT="/Users/chris/code/camp-planner/public/xp"
mkdir -p "$OUT"

# resize <source-name-without-ext> <out-name-without-ext> <size>
resize() {
  local src="$SRC/$1.png" dst="$OUT/$2.png" size="$3"
  if [[ ! -f "$src" ]]; then echo "MISSING: $src" >&2; exit 1; fi
  sips -s format png -Z "$size" "$src" --out "$dst" >/dev/null
  echo "  $2.png  (${size}px)"
}

echo "Start-menu icons (44px):"
resize "My Computer"        "my-computer"    44
resize "Folder Closed"      "folder"         44
resize "New Folder"         "new-folder"     44
resize "OE Create Mail"     "feedback"       44
resize "Control Panel"      "control-panel"  44
resize "Logout"             "logoff"         44
resize "Switch User"        "logon"          44

echo "Message-box icons (96px):"
resize "Critical"           "dlg-error"      96
resize "Information"        "dlg-info"       96
resize "Question"           "dlg-question"   96
resize "Alert"              "dlg-warning"    96
resize "Success"            "dlg-success"    96
resize "Security Alert"     "dlg-security"   96

echo "Control Panel category icons (44px):"
resize "Date and Time"      "cp-datetime"    44
resize "User Accounts"      "cp-accounts"    44
resize "Appearance"         "cp-appearance"  44

echo "Tray (32px):"
resize "Volume"             "tray-volume"    32

echo "Done -> $OUT"
du -sh "$OUT"
