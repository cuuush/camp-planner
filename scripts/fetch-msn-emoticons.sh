#!/usr/bin/env bash
# Grab the "retro" (8-bit, non-animated) MSN emoticon PNGs from
# github.com/bernzrdo/msn-emoticons and drop them into public/msn/ so the app
# can serve them as static assets. One tarball download, then copy the folder.
set -euo pipefail

REPO_TARBALL="https://github.com/bernzrdo/msn-emoticons/archive/refs/heads/main.tar.gz"
DEST="/Users/chris/code/camp-planner/public/msn"
TMP="$(mktemp -d)"

echo "downloading tarball…"
curl -fsSL -o "$TMP/msn.tar.gz" "$REPO_TARBALL"

echo "extracting…"
tar xzf "$TMP/msn.tar.gz" -C "$TMP"

mkdir -p "$DEST"
cp "$TMP"/msn-emoticons-main/retro/*.png "$DEST"/

echo "copied $(ls "$DEST" | wc -l | tr -d ' ') emoticons to $DEST"
ls "$DEST"

rm -rf "$TMP"
