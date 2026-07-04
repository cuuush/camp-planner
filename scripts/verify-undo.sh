#!/usr/bin/env bash
#
# verify-undo.sh — the audit harness that found (and now guards) every undo bug in
# UNDO_PLAN.md. It drives a running dev instance with curl and inspects the local
# D1 sqlite file directly, because — per AGENTS.md — curl proves the HTML is there
# but NOT that the right rows moved. Reading the DB is how we actually know.
#
# ─── Setup (once) ───────────────────────────────────────────────────────────────
#   npm run db:migrate:local          # schema.sql → fresh local D1
#   for f in migrations/0*.sql; do \
#       npx wrangler d1 execute camp-planner-db --local --file="$f"; done
#   npm run db:seed:local             # fest 1 + its items
#   npx wrangler dev --ip 127.0.0.1 --port 8787   # leave running in another shell
#
# ─── Run ────────────────────────────────────────────────────────────────────────
#   scripts/verify-undo.sh                        # against 127.0.0.1:8787
#   BASE=http://127.0.0.1:8787 scripts/verify-undo.sh
#
# Each scenario maps to a numbered case in UNDO_PLAN.md §7 and prints PASS/FAIL.
# The script mutates the local DB, so re-seed between full runs for a clean slate.
# It is intentionally dependency-light: bash + curl + python3 (stdlib sqlite3).

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
JAR_DIR="$(mktemp -d)"
trap 'rm -rf "$JAR_DIR"' EXIT

pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }

# --- locate the miniflare sqlite file wrangler dev is using -----------------------
DB_FILE="$(ls -t .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite 2>/dev/null | head -1)"
if [ -z "${DB_FILE:-}" ] || [ ! -f "$DB_FILE" ]; then
    echo "Could not find local D1 sqlite under .wrangler/state — is the dev server running with a migrated+seeded DB?"
    exit 2
fi

# sql "<query>" → prints the scalar/rows from the read-only DB.
sql() {
    python3 - "$DB_FILE" "$1" <<'PY'
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
for row in con.execute(sys.argv[2]).fetchall():
    print("|".join("" if v is None else str(v) for v in row))
PY
}

# signin <label> <name> <next> → creates a cookie jar at $JAR_DIR/<label>.
# An EXISTING name via plain (non-htmx) curl signs in directly (trust-based), so
# this works for both first sign-in and returning.
signin() {
    curl -s -c "$JAR_DIR/$1" -b "$JAR_DIR/$1" -o /dev/null \
        -X POST "$BASE/signin" \
        --data-urlencode "name=$2" --data-urlencode "next=$3"
}
# post <label> <path> [--data k=v ...] → authenticated POST with that jar.
post() {
    local label="$1" path="$2"; shift 2
    curl -s -b "$JAR_DIR/$label" -o /dev/null "$@" -X POST "$BASE$path"
}

echo "Harness DB: $DB_FILE"
echo "Base URL:   $BASE"
echo

# ── Scenario 1 — Bail undo restores pledges + seats (G2) ─────────────────────────
echo "1. Bail undo (G2): pledge + seat + bail, then undo the bail"
signin s1 "Bailey" "/f/1/stuff"
ITEM=$(sql "SELECT id FROM items WHERE festival_id=1 ORDER BY id LIMIT 1")
PID=$(sql "SELECT id FROM people WHERE display_name='Bailey'")
post s1 "/items/$ITEM/pledge" --data "qty=2"
post s1 "/f/1/cars" --data "seats_total=4" --data "leaving_from=oakland"
CAR=$(sql "SELECT id FROM cars WHERE driver_person_id=$PID ORDER BY id DESC LIMIT 1")
post s1 "/f/1/people/$PID/bail"
BAIL_ENTRY=$(sql "SELECT id FROM audit_log WHERE action='bail' AND person_id IS NOT NULL ORDER BY id DESC LIMIT 1")
# (bail's actor is whoever clicked; entity is the membership row. Find latest bail.)
BAIL_ENTRY=$(sql "SELECT id FROM audit_log WHERE action='bail' ORDER BY id DESC LIMIT 1")
post s1 "/f/1/log/$BAIL_ENTRY/undo"
PLEDGE_LIVE=$(sql "SELECT count(*) FROM pledges WHERE person_id=$PID AND item_id=$ITEM AND deleted_at IS NULL")
SEAT_LIVE=$(sql "SELECT count(*) FROM seats WHERE person_id=$PID AND car_id=$CAR AND deleted_at IS NULL")
MEMB_LIVE=$(sql "SELECT count(*) FROM memberships WHERE person_id=$PID AND festival_id=1 AND bailed_at IS NULL")
[ "$MEMB_LIVE" = "1" ] && ok "membership restored" || bad "membership not restored ($MEMB_LIVE)"
[ "$PLEDGE_LIVE" = "1" ] && ok "pledge restored" || bad "pledge NOT restored ($PLEDGE_LIVE) — G2"
[ "$SEAT_LIVE" = "1" ] && ok "seat restored" || bad "seat NOT restored ($SEAT_LIVE) — G2"
echo

# ── Scenario 7 — Stale update undo skips instead of clobbering (G5) ───────────────
echo "7. Stale update (G5): qty 3→6→8, undo the FIRST edit → stays 8"
signin s7 "Editor" "/f/1/stuff"
post s7 "/items/$ITEM/edit" --data "needed_qty=6" --data "name=" --data "emoji=" --data "unit="
EDIT1=$(sql "SELECT id FROM audit_log WHERE action='update' AND entity_type='items' AND entity_id=$ITEM ORDER BY id DESC LIMIT 1")
post s7 "/items/$ITEM/edit" --data "needed_qty=8" --data "name=" --data "emoji=" --data "unit="
post s7 "/f/1/log/$EDIT1/undo"
QTY=$(sql "SELECT needed_qty FROM items WHERE id=$ITEM")
[ "$QTY" = "8" ] && ok "qty stayed 8 (first edit's undo was skipped)" || bad "qty is $QTY, expected 8 — G5 clobber"
echo

# ── Scenario 8 — Cross-fest forgery is refused (G6) ──────────────────────────────
echo "8. Cross-fest forgery (G6): undo a fest-1 entry via a fest-2 URL → 404"
signin s8 "Forger" "/f/1/stuff"
FEST1_ENTRY=$(sql "SELECT id FROM audit_log WHERE festival_id=1 AND reversible=1 ORDER BY id DESC LIMIT 1")
CODE=$(curl -s -b "$JAR_DIR/s8" -o /dev/null -w "%{http_code}" -X POST "$BASE/f/999999/log/$FEST1_ENTRY/undo")
[ "$CODE" = "404" ] && ok "cross-fest undo returned 404" || bad "expected 404, got $CODE — G6"
echo

echo "──────────────────────────────────────────"
echo "PASS: $pass    FAIL: $fail"
[ "$fail" -eq 0 ] || exit 1
