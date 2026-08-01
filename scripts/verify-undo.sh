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
DB_FILE="${DB_FILE:-$(ls -t .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite 2>/dev/null | head -1)}"
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

# ── Scenario 4 — Double-pledge resurrect is refused (G3) ─────────────────────────
echo "4. Double-pledge resurrect (G3): pledge, get deleted, pledge again, undo delete"
signin s4 "Dupe" "/f/1/stuff"
DPID=$(sql "SELECT id FROM people WHERE display_name='Dupe'")
ITEM4=$(sql "SELECT id FROM items WHERE festival_id=1 ORDER BY id LIMIT 1 OFFSET 1")
post s4 "/items/$ITEM4/pledge" --data "qty=3"
# an admin removes Dupe from the fest (their pledge is hidden by the manifest)…
signin adm "Admin" "/f/1/stuff"
post adm "/f/1/people/delete" --data "person_ids=$DPID"
DEL4=$(sql "SELECT id FROM audit_log WHERE action='delete' AND entity_type='people' AND entity_id=$DPID ORDER BY id DESC LIMIT 1")
# Dupe signs back in (fresh session, since delete ended the old one) and re-pledges…
signin s4b "Dupe" "/f/1/stuff"
post s4b "/items/$ITEM4/pledge" --data "qty=5"
# …now undo the delete. The old pledge must STAY hidden (a live one exists).
post adm "/f/1/log/$DEL4/undo"
LIVE_PLEDGES=$(sql "SELECT count(*) FROM pledges WHERE item_id=$ITEM4 AND person_id=$DPID AND deleted_at IS NULL")
LIVE_QTY=$(sql "SELECT qty FROM pledges WHERE item_id=$ITEM4 AND person_id=$DPID AND deleted_at IS NULL")
[ "$LIVE_PLEDGES" = "1" ] && ok "exactly one live pledge (no resurrection)" || bad "found $LIVE_PLEDGES live pledges — G3 corruption"
[ "$LIVE_QTY" = "5" ] && ok "the surviving pledge is the new one (5)" || bad "surviving pledge qty is $LIVE_QTY, expected 5"
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

# ── Scenario 5 — Reversible merge of two reals (G1, G7) ──────────────────────────
echo "5. Merge two reals (G1): both vote an item, merge B→A, then un-merge"
signin ma "Alpha" "/f/1/stuff"
signin mb "Beta" "/f/1/stuff"
AID=$(sql "SELECT id FROM people WHERE display_name='Alpha'")
BID=$(sql "SELECT id FROM people WHERE display_name='Beta'")
# Beta manually places someone on this festival's roster. That attribution should
# follow Beta's identity through an ordinary merge, then return on un-merge.
post mb "/f/1/people/add" --data "name=Gamma"
GAMMA_MID=$(sql "SELECT m.id FROM memberships m JOIN people p ON p.id=m.person_id WHERE p.display_name='Gamma' AND m.festival_id=1")
ITEM5=$(sql "SELECT id FROM items WHERE festival_id=1 ORDER BY id LIMIT 1 OFFSET 2")
post ma "/items/$ITEM5/vote"
post mb "/items/$ITEM5/vote"
# merge Beta → Alpha (select order: Alpha first = survivor)
post ma "/f/1/people/merge" --data "person_ids=$AID,$BID"
BROW=$(sql "SELECT count(*) FROM people WHERE id=$BID")
BDEL=$(sql "SELECT deleted_at FROM people WHERE id=$BID")
BINTO=$(sql "SELECT merged_into FROM people WHERE id=$BID")
BVOTE=$(sql "SELECT count(*) FROM votes WHERE person_id=$BID")
BSESS=$(sql "SELECT count(*) FROM sessions WHERE person_id=$BID")
GAMMA_ADDER=$(sql "SELECT added_by FROM memberships WHERE id=$GAMMA_MID")
MERGE_ENTRY=$(sql "SELECT id FROM audit_log WHERE action='merge' AND entity_id=$AID ORDER BY id DESC LIMIT 1")
[ "$BROW" = "1" ] && ok "Beta's person row still exists (soft-deleted, not destroyed)" || bad "Beta row hard-deleted — G1"
[ -n "$BDEL" ] && [ "$BINTO" = "$AID" ] && ok "Beta soft-deleted + merged_into=Alpha" || bad "Beta not soft-merged (deleted=$BDEL into=$BINTO)"
[ "$BVOTE" = "1" ] && ok "Beta's vote row preserved (not destroyed)" || bad "Beta's vote row gone ($BVOTE) — G1"
[ "$BSESS" = "0" ] && ok "Beta's sessions dropped (device can't be the survivor)" || bad "Beta sessions remain ($BSESS) — G7"
[ "$GAMMA_ADDER" = "$AID" ] && ok "ordinary merge repointed festival roster provenance" || bad "ordinary merge corrupted roster provenance (adder=$GAMMA_ADDER)"
[ -n "$MERGE_ENTRY" ] && ok "merge logged with an undo button (reversible)" || bad "merge not logged reversibly"
# now UN-MERGE
post ma "/f/1/log/$MERGE_ENTRY/undo"
BDEL2=$(sql "SELECT deleted_at FROM people WHERE id=$BID")
BINTO2=$(sql "SELECT merged_into FROM people WHERE id=$BID")
BVOTE2=$(sql "SELECT count(*) FROM votes WHERE person_id=$BID AND deleted_at IS NULL")
GAMMA_ADDER2=$(sql "SELECT added_by FROM memberships WHERE id=$GAMMA_MID")
[ -z "$BDEL2" ] && [ -z "$BINTO2" ] && ok "un-merge: Beta live again (deleted_at & merged_into cleared)" || bad "un-merge left Beta merged (deleted=$BDEL2 into=$BINTO2)"
[ "$BVOTE2" = "1" ] && ok "un-merge: Beta's vote back on Beta" || bad "un-merge didn't restore Beta's vote ($BVOTE2)"
[ "$GAMMA_ADDER2" = "$BID" ] && ok "un-merge restored festival roster provenance" || bad "un-merge did not restore roster provenance (adder=$GAMMA_ADDER2)"
echo

# ── Scenario 9 — Absorb is logged; dead ghosts don't absorb (G8) ─────────────────
echo "9. Absorb (G8): ghost absorbed+logged; a removed ghost does NOT absorb"
signin adder "Adder" "/f/1/stuff"
ADDER_ID=$(sql "SELECT id FROM people WHERE display_name='Adder'")

# Both Cars paths that accept a brand-new name create festival-roster placeholders.
# They carry the same temporary attribution as a People-tab add, while the actor's
# ordinary self-service membership stays unattributed.
post adder "/f/1/cars" --data "driver_person_id=__new__" --data "new_driver_name=DriverGhost" --data "seats_total=4"
DRIVER_GID=$(sql "SELECT id FROM people WHERE display_name='DriverGhost' AND is_placeholder=1")
DRIVER_CAR=$(sql "SELECT id FROM cars WHERE driver_person_id=$DRIVER_GID ORDER BY id DESC LIMIT 1")
post adder "/cars/$DRIVER_CAR/seats/add-new" --data "name=PassengerGhost"
PASSENGER_GID=$(sql "SELECT id FROM people WHERE display_name='PassengerGhost' AND is_placeholder=1")
DRIVER_ADDER=$(sql "SELECT added_by FROM memberships WHERE festival_id=1 AND person_id=$DRIVER_GID")
PASSENGER_ADDER=$(sql "SELECT added_by FROM memberships WHERE festival_id=1 AND person_id=$PASSENGER_GID")
SELF_ADDER=$(sql "SELECT added_by FROM memberships WHERE festival_id=1 AND person_id=$ADDER_ID")
PPL_HTML=$(curl -s "$BASE/f/1/ppl")
[ "$DRIVER_ADDER" = "$ADDER_ID" ] && ok "new car driver recorded festival roster provenance" || bad "new car driver did not record the actor (adder=$DRIVER_ADDER)"
[ "$PASSENGER_ADDER" = "$ADDER_ID" ] && ok "new car passenger recorded festival roster provenance" || bad "new car passenger did not record the actor (adder=$PASSENGER_ADDER)"
[ -z "$SELF_ADDER" ] && ok "self-service membership stayed unattributed" || bad "self-service membership was attributed (adder=$SELF_ADDER)"
printf '%s' "$PPL_HTML" | grep -q 'DriverGhost.*ppl-added-by.*(Adder)' \
    && ok "People page rendered car-driver attribution" || bad "People page omitted car-driver attribution"
printf '%s' "$PPL_HTML" | grep -q 'PassengerGhost.*ppl-added-by.*(Adder)' \
    && ok "People page rendered car-passenger attribution" || bad "People page omitted car-passenger attribution"
printf '%s' "$PPL_HTML" | grep -q 'who manually added that person to this festival' \
    && ok "People page explained the shared manual-add label" || bad "People page omitted the attribution helper note"

# The attribution is temporary for a car-created placeholder too, with the same
# reversible absorption behavior as a placeholder created from the People tab.
signin driverghost "DriverGhost" "/f/1/stuff"
DRIVER_REAL_ID=$(sql "SELECT id FROM people WHERE display_name='DriverGhost' AND is_placeholder=0")
DRIVER_ABSORB=$(sql "SELECT id FROM audit_log WHERE action='merge' AND entity_id=$DRIVER_REAL_ID ORDER BY id DESC LIMIT 1")
DRIVER_ATTR_AFTER=$(sql "SELECT count(*) FROM memberships WHERE festival_id=1 AND person_id IN ($DRIVER_GID,$DRIVER_REAL_ID) AND added_by IS NOT NULL")
[ "$DRIVER_ATTR_AFTER" = "0" ] && ok "car-placeholder sign-in consumed temporary attribution" || bad "car-placeholder attribution survived sign-in ($DRIVER_ATTR_AFTER rows)"
post adder "/f/1/log/$DRIVER_ABSORB/undo"
DRIVER_ATTR_UNDONE=$(sql "SELECT added_by FROM memberships WHERE festival_id=1 AND person_id=$DRIVER_GID AND bailed_at IS NULL")
[ "$DRIVER_ATTR_UNDONE" = "$ADDER_ID" ] && ok "un-merge restored car-placeholder attribution" || bad "un-merge did not restore car attribution (adder=$DRIVER_ATTR_UNDONE)"
post adder "/f/1/log/$DRIVER_ABSORB/undo"
DRIVER_ATTR_REDONE=$(sql "SELECT count(*) FROM memberships WHERE festival_id=1 AND person_id IN ($DRIVER_GID,$DRIVER_REAL_ID) AND added_by IS NOT NULL")
[ "$DRIVER_ATTR_REDONE" = "0" ] && ok "redo consumed car-placeholder attribution again" || bad "redo restored stale car attribution ($DRIVER_ATTR_REDONE rows)"

post adder "/f/1/people/add" --data "name=Casper"
GID=$(sql "SELECT id FROM people WHERE display_name='Casper' AND is_placeholder=1")
MANUAL_BEFORE=$(sql "SELECT added_by FROM memberships WHERE festival_id=1 AND person_id=$GID")
signin casper "Casper" "/f/1/stuff"    # real Casper signs in → should absorb the ghost
CASPER_ID=$(sql "SELECT id FROM people WHERE display_name='Casper' AND is_placeholder=0")
ABSORB_ENTRY=$(sql "SELECT id FROM audit_log WHERE action='merge' AND summary LIKE '%linked up their pre-added entry%' ORDER BY id DESC LIMIT 1")
GHOST_GONE=$(sql "SELECT deleted_at FROM people WHERE id=$GID")
MANUAL_AFTER=$(sql "SELECT count(*) FROM memberships WHERE festival_id=1 AND person_id IN ($GID,$CASPER_ID) AND added_by IS NOT NULL")
[ "$MANUAL_BEFORE" = "$ADDER_ID" ] && ok "People add recorded festival roster provenance" || bad "People add did not record the adder (adder=$MANUAL_BEFORE)"
[ -n "$ABSORB_ENTRY" ] && ok "absorb was logged as a reversible merge" || bad "absorb not logged — G8"
[ -n "$GHOST_GONE" ] && ok "ghost soft-merged into the real Casper" || bad "ghost not merged"
[ "$MANUAL_AFTER" = "0" ] && ok "absorb consumed manual-add attribution" || bad "manual-add attribution survived absorption ($MANUAL_AFTER rows)"
post adder "/f/1/log/$ABSORB_ENTRY/undo"
MANUAL_UNDONE=$(sql "SELECT added_by FROM memberships WHERE festival_id=1 AND person_id=$GID AND bailed_at IS NULL")
[ "$MANUAL_UNDONE" = "$ADDER_ID" ] && ok "un-merge restored placeholder attribution" || bad "un-merge did not restore placeholder attribution (adder=$MANUAL_UNDONE)"
post adder "/f/1/log/$ABSORB_ENTRY/undo"
MANUAL_REDONE=$(sql "SELECT count(*) FROM memberships WHERE festival_id=1 AND person_id IN ($GID,$CASPER_ID) AND added_by IS NOT NULL")
[ "$MANUAL_REDONE" = "0" ] && ok "redo consumed placeholder attribution again" || bad "redo restored stale attribution ($MANUAL_REDONE rows)"
# dead ghost: add + delete a ghost, then sign in with its name → NO absorb, fresh acct
post adder "/f/1/people/add" --data "name=Wisp"
WID=$(sql "SELECT id FROM people WHERE display_name='Wisp' AND is_placeholder=1")
post adder "/f/1/people/delete" --data "person_ids=$WID"
signin wisp "Wisp" "/f/1/stuff"
WISP_REAL=$(sql "SELECT count(*) FROM people WHERE placeholder_key IS NULL AND normalized_name NOT LIKE '__ph_%' AND display_name='Wisp'")
GHOST_STILL_DEAD=$(sql "SELECT count(*) FROM people WHERE id=$WID AND merged_into IS NOT NULL")
[ "$GHOST_STILL_DEAD" = "0" ] && ok "dead ghost was NOT absorbed by the new sign-in" || bad "dead ghost got glued to sign-in — G8"
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
