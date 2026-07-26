#!/usr/bin/env bash
# Build the MAIN pixmoji font: UnifontEX, subset to just the emoji codepoints we
# actually pixel-ify.
#
# Why: the full UnifontExMono.woff2 covers all of Unicode and weighs 2.0 MB. We
# were loading it from cdn.jsdelivr.net — a 2 MB third-party fetch to draw a few
# chunky emoji. The client only ever wraps codepoints in PIXMOJI_COVERED_RANGES
# (src/render/pixmoji-coverage.js) in a .pixmoji span; every other character
# renders as a native color emoji and never touches this font. So subsetting to
# exactly that set is behaviour-identical by construction, not a trade-off.
#
# The unicode list is DERIVED from pixmoji-coverage.js, so the font and the
# client's coverage check can never drift apart. Regenerate that file first
# (scripts/gen-pixmoji-coverage.mjs) if the coverage changes, then re-run this.
set -euo pipefail

REPO="/Users/chris/code/camp-planner"
# Upstream source of truth for UnifontEX. Same file the CDN @font-face used.
SRC_URL="https://cdn.jsdelivr.net/gh/stgiga/UnifontEX/UnifontExMono.woff2"
DEST="$REPO/public/fonts"
# Version suffix = cache-bust: /fonts/* ships immutable for a year, so a changed
# font MUST get a new filename (and a matching @font-face URL in retro.css).
OUT="$DEST/unifontex-pixmoji1.woff2"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "ensuring fonttools + brotli (in an isolated venv)…"
VENV="$TMP/venv"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet fonttools brotli

echo "deriving unicode ranges from pixmoji-coverage.js…"
# [start,end,start,end,…] -> "U+xxxx-yyyy,U+…" for fontTools.subset.
UNICODES="$(node --input-type=module -e "
import { PIXMOJI_COVERED_RANGES as r } from '$REPO/src/render/pixmoji-coverage.js';
const out = [];
for (let i = 0; i < r.length; i += 2) {
  const a = r[i].toString(16).toUpperCase(), b = r[i + 1].toString(16).toUpperCase();
  out.push(r[i] === r[i + 1] ? \`U+\${a}\` : \`U+\${a}-\${b}\`);
}
process.stdout.write(out.join(','));
")"
echo "  $(printf '%s' "$UNICODES" | tr ',' '\n' | wc -l | tr -d ' ') ranges"

echo "downloading UnifontExMono.woff2…"
curl -fsSL -o "$TMP/src.woff2" "$SRC_URL"
echo "  source size: $(du -h "$TMP/src.woff2" | cut -f1)"

mkdir -p "$DEST"
echo "subsetting -> woff2…"
# NOTE: keep the name table (no --name-IDs='')! Stripping it saves ~1KB but iOS
# Safari REJECTS fonts with an empty name table — the font silently fails to load
# and emoji fall back to Apple Color Emoji on phones while desktop Chrome looks
# fine. Same trap as build-unifont-emoji.sh; don't "optimise" it away.
# --drop-tables+=BASE: UnifontEX ships a MALFORMED BASE table (a truncated
# MinCoord record). fontTools reads it lazily, so the subset itself succeeds and
# it only explodes on write, with a bare `struct.error: unpack requires a buffer
# of 2 bytes` and no mention of the font. BASE is horizontal/vertical baseline
# metadata — meaningless for a font we use exclusively to draw emoji — so drop it
# rather than trying to repair it. If this build ever fails on another obscure
# 4-letter tag, suspect the same thing.
"$VENV/bin/python" -m fontTools.subset "$TMP/src.woff2" \
  --unicodes="$UNICODES" \
  --flavor=woff2 \
  --output-file="$OUT" \
  --drop-tables+=BASE \
  --no-hinting --desubroutinize --notdef-outline

echo "done: $OUT ($(du -h "$OUT" | cut -f1))"
