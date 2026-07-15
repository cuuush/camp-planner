#!/usr/bin/env bash
# Curate a small set of authentic Windows XP icons from the downloaded high-res
# pack into public/xp/, resized to sane sizes (the source PNGs are 1024²/256K+).
# Start-menu icons render ~22px, so 44px stays crisp on retina; message-box icons
# render ~48px, so 96px is plenty. Keeps the repo small while looking authentic.
#
# THIS SCRIPT ONLY BUILDS WHAT IS MISSING. sips re-encodes on every run and its
# output isn't byte-stable, so re-making an icon that hasn't changed still rewrites
# the file — running this to swap ONE icon used to leave a dozen unrelated PNGs
# showing as modified in git. It also means you can run it without the source pack
# on disk: everything already built is simply skipped.
#
#   ./scripts/make-xp-icons.sh                 # build only what's absent
#   ./scripts/make-xp-icons.sh desk-cars       # force-rebuild just these
#   FORCE=1 ./scripts/make-xp-icons.sh         # rebuild everything (expect churn)
set -euo pipefail

SRC="/Users/chris/Downloads/Windows XP High Resolution Icon Pack/Windows XP Icons"
OUT="/Users/chris/code/camp-planner/public/xp"
mkdir -p "$OUT"

# Icons named on the command line get rebuilt even if they already exist. Kept as a
# padded string rather than an array: macOS still ships bash 3.2, where expanding an
# EMPTY array under `set -u` is itself an "unbound variable" error.
ARGS=" $* "
wanted() { [[ "$ARGS" == *" $1 "* ]]; }

# resize <source-name-without-ext> <out-name-without-ext> <size>
resize() {
  local src="$SRC/$1.png" dst="$OUT/$2.png" size="$3"
  if [[ -f "$dst" && -z "${FORCE:-}" ]] && ! wanted "$2"; then
    echo "  $2.png  (have it — skipped)"
    return
  fi
  # Only demand the source pack for something we're actually building.
  if [[ ! -f "$src" ]]; then echo "MISSING: $src" >&2; exit 1; fi
  sips -s format png -Z "$size" "$src" --out "$dst" >/dev/null
  echo "  $2.png  (${size}px)  <- built"
}

echo "Start-menu icons (44px):"
resize "My Computer"        "my-computer"    44
resize "Folder Closed"      "folder"         44
resize "New Folder"         "new-folder"     44
resize "OE Create Mail"     "feedback"       44
resize "Control Panel"      "control-panel"  44
resize "Administrative Tools" "admin"        44
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

echo "Meeting-spot banner (the fake Streets & Trips window on the cars tab):"
resize "My Network Places"  "globe"          44
resize "Favorites"          "fav-star"       32
resize "Internet Explorer 6" "ie"            32
resize "Search"             "search"         32
resize "Back"               "back"           32
resize "Forward"            "forward"        32
resize "Printer"            "printer"        32

echo "Desktop icons for the tab row (80px — rendered ~40px, crisp on retina):"
resize "Briefcase"          "desk-stuff"     80
resize "User Accounts"      "desk-people"    80
# Activation is XP's product-key icon — a car key by any other name. Beats the
# globe that was here (My Network Places), which said "network", not "ride".
resize "Activation"         "desk-cars"      80
resize "My Documents"       "desk-me"        80
resize "Event Viewer"       "desk-log"       80
resize "Windows Media Player 10" "desk-schedule" 80

echo "Done -> $OUT"
du -sh "$OUT"
