#!/usr/bin/env bash
# Build a small emoji-only web font from the latest GNU Unifont (Unicode 16) to
# fill the gaps UnifontEX (which stops at Unicode 11) leaves — mirror, wood,
# chair, coin, and every 2019+ emoji. We subset ONLY the Plane-1 emoji blocks
# (U+1F000–U+1FAFF) so the file stays tiny, then ship it as woff2.
set -euo pipefail

VER="16.0.04"
OTF_URL="https://unifoundry.com/pub/unifont/unifont-${VER}/font-builds/unifont_upper-${VER}.otf"
DEST="/Users/chris/code/camp-planner/public/fonts"
OUT="$DEST/unifont-emoji16.woff2"
TMP="$(mktemp -d)"

echo "ensuring fonttools + brotli (in an isolated venv)…"
VENV="$TMP/venv"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet fonttools brotli

echo "downloading unifont_upper ${VER}.otf…"
curl -fsSL -o "$TMP/upper.otf" "$OTF_URL"
echo "  otf size: $(du -h "$TMP/upper.otf" | cut -f1)"

mkdir -p "$DEST"
echo "subsetting emoji blocks -> woff2…"
"$VENV/bin/python" -m fontTools.subset "$TMP/upper.otf" \
  --unicodes="U+1F000-1FAFF" \
  --flavor=woff2 \
  --output-file="$OUT" \
  --no-hinting --desubroutinize --name-IDs='' --notdef-outline

echo "done: $OUT ($(du -h "$OUT" | cut -f1))"
rm -rf "$TMP"
