# UNDO_PLAN.md — make undo actually perfect

**Read this whole file before writing code. Also read `AGENTS.md` first — especially
the migration conventions and the "curl is not sufficient" rule.**

This plan is the output of a full audit of the undo/audit system (2026-07-04). Every
gap below was either demonstrated live against a running dev instance or confirmed
directly from the code, with the receipts inline. The goal is not to patch symptoms:
it is to rebuild undo on one uniform, guarded, atomic mechanism so that **every
reversible action undoes completely, honestly, and safely — no matter what happened
in between.** No hacks. When a tradeoff appears, this file says which side to take
and why.

---

## 1. How undo works today (so you don't have to re-derive it)

- Every mutation calls `logAction()` (`src/lib/audit.js`) → a row in `audit_log`
  with `action`, `entity_type`, `entity_id`, optional `before_json`/`after_json`,
  and a `reversible` flag. The log tab (`src/routes/log.js`) shows an undo/redo
  button for reversible, not-yet-undone entries.
- `undoAction()` toggles: if the entry is live it applies `revertEffect()`, marks
  `undone_at`; if already undone it applies `reapplyEffect()`. Clicking an `undo`
  entry toggles the ORIGINAL entry it points to (`undo_of_id`) — this is what makes
  redo-of-undo work indefinitely. **This toggle design is good. Keep it.**
- `revertEffect`/`reapplyEffect` know four shapes:
  - `create`/`delete` on a table in `SOFT_DELETE_TABLES` → flip `deleted_at`
  - `update` → blind-write the full `before_json`/`after_json` snapshot
  - `bail` → flip `memberships.bailed_at`
  - `entity_type === 'people' && action === 'delete'` → person-delete **manifest**:
    `deletePersonFootprint()` (`src/lib/people.js`) records every active row id it
    soft-hides (pledges/seats/votes/comments/cars/checks/memberships);
    `restoreFootprint()`/`purgeFootprint()` walk it back. **This manifest idea is
    the seed of the right design — we're generalizing it to everything.**

### What already works — verified, do not regress
- Simple person delete → undo restores every seat/check/membership exactly.
- Undo → redo → undo ping-pong works indefinitely.
- Car delete keeps seat rows untouched, so its undo is complete.
- The log UI correctly hides buttons for irreversible/spent entries.

---

## 2. The gaps (all confirmed)

| # | Gap | Severity | Proof |
|---|-----|----------|-------|
| G1 | **Merge is irreversible and destructive.** `mergePeople()` hard-DELETEs the source `people` row and every deduped row (memberships, seats, votes, checks), blanket-reassigns the rest with no record, and rewrites `audit_log.person_id` so even history can't reconstruct the split. Log entry is `reversible=0`. | Critical | Merged "Dupe B"→"Dupe A": B's person row gone (`count=0`), B's vote row gone, "Dupe B joined camp planner" now attributed to A's id. |
| G2 | **Bail undo is half an undo.** Bail soft-deletes the person's pledges + seats but logs only the membership flip; undo restores membership, pledges/seats stay silently gone. | High | Pledge+seat+bail, undo: `bailed_at=NULL` but pledge and seat still `deleted_at=<set>`. |
| G3 | **Undo resurrects rows into states the app forbids.** Person-delete doesn't end sessions; any action by the deleted person auto-rejoins them (`logAction`→`ensureMembership`) and creates fresh rows; undoing the old delete then restores the manifest rows alongside → e.g. two live pledges by one person on one item (the pledge route itself prevents this state). | High | Demonstrated: "Dupe A (3), Dupe A (5)" both active on one item. |
| G4 | **Hard deletes orphan manifests → silent partial undo.** Merge's dedupe DELETEs can destroy rows referenced by an earlier person-delete manifest; `restoreFootprint` UPDATEs a missing id = silent no-op. (In the absorb-on-signin path this is currently masked only because `absorbPlaceholders` happens to run before `joinFestFromNext` in `auth.js` — one reorder away from breaking.) | High | Structural + demonstrated vote-row destruction. |
| G5 | **Update undo clobbers newer edits.** `before_json` holds ALL fields (item edit snapshots name/emoji/qty/unit/description); undoing an old qty edit also reverts newer renames, and blind-writes stale values (3→6→8, undo first edit → back to 3, the 8 is silently lost). | Medium | Demonstrated on item edit. |
| G6 | **Cross-festival undo forgery.** `POST /f/:id/log/:auditId/undo` never checks the entry belongs to festival `:id`. Any signed-in user can undo any fest's entries through any fest's URL. | Medium | `POST /f/2/log/18/undo` executed a fest-1 entry. |
| G7 | **Merge hands the survivor's account to the merged-away person's device.** `mergePeople` reassigns `sessions.person_id`, so the source person's browser silently becomes the target account. | Medium | Code: `UPDATE sessions SET person_id = ? WHERE person_id = ?`. |
| G8 | **Absorb is unlogged and over-eager.** `absorbPlaceholders` (sign-in) merges by bare name match across ALL festivals, including ghosts that were deliberately removed from a fest; the merge appears nowhere in the log. | Medium | Code: matches `placeholder_key` globally, no `logAction`. |
| G9 | **Adding a ghost person is logged `reversible: false`** — the one create in the app you can't undo from the log; you must enter Delete mode instead. | Low | `src/routes/people.js` `/f/:id/people/add`. |
| G10 | **Undoing an item edit leaves its auto-note chat comment** ("changed how many are needed from 3 to 6") contradicting reality. | Low | Code: auto-note insert is deliberately unlogged. |
| G11 | **Nothing is atomic.** `mergePeople` (14 statements), `deletePersonFootprint`, `undoAction` (effect + flag + log insert) all run statement-by-statement; a mid-way failure leaves half-applied state that no log entry describes. D1 supports `db.batch()` (transactional) — unused. | Medium | Code. |
| G12 | **Root cause: one soft-delete bit, many independent owners.** A pledge's `deleted_at` can be flipped by its own create/withdraw entries, a person-delete manifest, a bail release, and redo — none aware of the others, no expected-state check. Every interleaving bug above is an instance of this. | — | This is the design flaw the plan fixes. |

---

## 3. Target design — the effects engine

One idea fixes G2, G3, G4, G5, G11, G12 uniformly:

> **Every reversible action records, at write time, the exact list of cell-level
> changes it made ("effects"). One generic engine reverts or reapplies an effects
> list — guarded, atomic, and honest about anything it had to skip.**

This is `deletePersonFootprint`'s manifest idea, generalized and made precise.

### 3.1 The effects format

`audit_log` gets a new nullable column `effects_json`: an ordered JSON array of
primitive effects. One effect = one cell of one row:

```json
[
  { "t": "memberships", "id": 10, "col": "bailed_at",  "from": null, "to": "2026-07-04 13:55:42" },
  { "t": "pledges",     "id": 1,  "col": "deleted_at", "from": null, "to": "2026-07-04 13:55:42" },
  { "t": "seats",       "id": 2,  "col": "deleted_at", "from": null, "to": "2026-07-04 13:55:42" }
]
```

(that example IS the fix for G2 — a bail that finally remembers what it released.)

- `from` = the cell value before the action; `to` = after. **Revert** applies
  `from` where the cell currently equals `to`; **reapply** applies `to` where the
  cell currently equals `from`.
- Multi-column updates emit one effect per **changed** column only (fixes the
  G5 all-fields clobber).
- Keep `before_json`/`after_json` exactly as they are — old rows in prod depend on
  them, and they're still useful for display. `effects_json` is additive.

### 3.2 The engine — new file `src/lib/effects.js`

```js
// applyEffects(db, effects, direction) — direction: 'revert' | 'reapply'
// Returns { applied: [...], skipped: [{ effect, reason }] }.
```

Behavior, precisely:

1. **Guards (fixes G12/G5):** for each effect, read the current cell. For revert,
   if `current !== to`, the row changed since this entry — **skip it** and record
   `reason: 'changed_since'`. If the row no longer exists, skip with
   `reason: 'row_missing'` (fixes the silent half of G4). Mirror-image for reapply.
2. **Domain guards (fixes G3):** when a revert/reapply would *un-hide* a row in
   `pledges` or `seats` (setting `deleted_at` from non-null to null), first check no
   OTHER active row exists for the same natural key (`pledges`: item_id+person_id;
   `seats`: car_id+person_id). If one does, skip with `reason: 'duplicate_active'`.
   (votes and checklist_checks have real UNIQUE constraints and toggle-reuse their
   rows, so they don't need this.)
3. **Atomicity (fixes G11):** collect every surviving UPDATE into one
   `db.batch([...])` together with the `audit_log.undone_at` flip and the new
   `undo` log-entry INSERT that `undoAction` writes. One batch = one transaction.
   Guards are pre-read before the batch; D1 serializes writes so the TOCTOU window
   is negligible at this scale — note this in a comment rather than pretending it's
   zero.
4. **Honesty (kills "silent"):** `undoAction` returns `skipped` to the route. When
   non-empty, `src/routes/log.js` responds with an `xpDialogPopup`
   (see `AGENTS.md` "Shared UI components", retarget to `#popup-layer` beforeend
   exactly like `nameTakenWarning` does) listing what was left alone and why, in
   authentic XP voice, e.g. *"2 items could not be restored because they were
   changed since this action. The rest of the action was undone."* Buttons: OK.

`undoAction` keeps its exact toggle semantics (clicked-undo-row → original,
spent-row marking, fresh `undo` entry). Only the effect application changes:
**if the entry has `effects_json`, use the engine; otherwise fall back to the
existing `revertEffect`/`reapplyEffect` + manifest code paths unchanged** (prod has
old rows forever — the legacy interpreter never gets deleted).

### 3.3 What each action logs, after this plan

| Action | Effects it records |
|---|---|
| create (item/pledge/vote/comment/car/seat/task/fest/ghost) | the row's `deleted_at: null` (revert = hide) |
| delete (same tables) | `deleted_at: null → now` |
| update (item edit, car edit, fest edit, pledge qty) | one effect per changed column |
| bail | membership `bailed_at` + every pledge/seat it released |
| person delete | the manifest, as effects (same rows `deletePersonFootprint` collects today) |
| **merge** | see §3.4 — reassignments + soft-dedupes + person soft-delete |
| ghost add | person row hide/unhide + its membership `bailed_at` flip (fixes G9) |
| item edit auto-note | include the auto-note comment row's `deleted_at` in the edit's own effects, so undoing the edit hides the stale note (fixes G10) |

---

## 4. Reversible merge (G1, G4, G7, G8) — the centerpiece

### 4.1 Schema — `migrations/004_people_soft_delete.sql`

Per AGENTS.md: small migrations, lexicographic order, `ALTER TABLE ADD COLUMN`
can't be idempotent and that's fine, update `schema.sql` with the same change.

```sql
ALTER TABLE people ADD COLUMN deleted_at TEXT;
ALTER TABLE people ADD COLUMN merged_into INTEGER;
```

And `migrations/005_audit_effects.sql`:

```sql
ALTER TABLE audit_log ADD COLUMN effects_json TEXT;
```

Deploy order rule from AGENTS.md applies: **migration lands before the code that
reads the column** (CI already enforces this ordering).

### 4.2 `mergePeople()` rewrite (`src/lib/people.js`)

New contract: `mergePeople(db, fromId, toId)` returns the effects array; callers
log it. Rules, table by table — the current dedupe queries stay, but their
*outcomes* change:

- **Dupe rows (source has one, target has one): soft-hide the source's, never
  DELETE.** memberships → set `bailed_at`; seats/votes → `deleted_at`;
  checklist_checks → `unchecked_at`. Keep `person_id` pointing at the source —
  that's what makes un-merge possible. Each flip is an effect.
- **Non-dupe rows: reassign `person_id` (or `driver_person_id`/`added_by`/
  `created_by`) from→to.** Each reassignment is an effect
  (`col: 'person_id', from: <fromId>, to: <toId>`). This is safe against UNIQUE
  constraints precisely because the dupe cases were already hidden above.
- **"Checked wins" flips on the target** (the existing
  `UPDATE checklist_checks ... WHERE person_id = toId` un-check→check promotion):
  keep it, record each as an effect.
- **The source person row: `deleted_at = now, merged_into = toId`. No DELETE.**
  Both column writes are effects.
- **`audit_log.person_id`: DO NOT rewrite. Delete that UPDATE.** History keeps
  true attribution forever. (Nothing user-facing joins audit person_id except the
  admin page's "last event" lookup, which is best-effort anyway.)
- **`sessions`: DO NOT reassign — DELETE the source's sessions** (fixes G7: the
  merged-away device must not become the survivor). Sessions are ephemeral
  credentials, not undo-domain state; on un-merge the person just signs in again.
  Not an effect.
- `name_reclaim_log`: keep the reassignment, record as effects.
- Whole thing (all UPDATEs) executes as **one `db.batch()`**.

The merge route (`src/routes/people.js`) then logs `reversible: true` with these
effects. **Undo of a merge = the engine walking the effects backwards**: rows
reassigned back, dedupe-hidden rows un-hidden (guarded), source person un-deleted.
Nothing special-cased.

### 4.3 Ripple effects of `people.deleted_at` — check every one

- `loadPerson` (`src/lib/session.js`): after loading, `if (person.deleted_at)
  return null;` — a merged-away identity can't act (its sessions are gone anyway;
  this is belt-and-braces).
- Sign-in name lookup (`auth.js`, both `/signin` and `/signin/reclaim` query
  `WHERE normalized_name = ?`): if the found person has `merged_into`, **follow the
  chain (loop until a person with no `merged_into`) and sign them into the
  surviving account.** Rationale: the merge asserted "these are the same human";
  honoring the name at sign-in is that assertion, not a hole. Add a
  `resolveMergedPerson(db, person)` helper in `src/lib/people.js`.
  After an un-merge, `merged_into` is nulled by the engine, so the name naturally
  belongs to the restored person again.
- `absorbPlaceholders`: skip ghosts where `deleted_at IS NOT NULL` (already
  merged/removed), and **skip ghosts with no active membership anywhere** — a
  ghost that was deliberately removed from its fest should not silently glue itself
  to whoever signs in with that name later (G8's sharp edge). Log each absorb it
  DOES perform: `action: 'merge'`, `reversible: true`, with the merge's effects and
  summary `"<name> signed in — linked up their pre-added entry"`. (Decision made
  here: name-matching stays global across fests — it's the documented product
  behavior for pre-added people — only *dead* ghosts stop absorbing.)
- People-list queries: `renderPplBody` filters through active memberships, which
  merge already bails — no change needed. `admin.js` lists everyone — fine, it's
  the admin page; optionally annotate "(merged into X)".
- FK display joins (`JOIN people` for display names in stats/chats): deleted
  people still resolve names correctly because the row exists. That's a feature of
  soft-delete — old chat messages keep their author's name.

---

## 5. Small fixes (do these first — they're independent)

1. **G6:** in `src/routes/log.js` undo handler, load the clicked entry and 404
   unless `entry.festival_id === festival.id`. (Or add the festival check inside
   `undoAction` — either way, one condition.)
2. **Merge confirm copy** (`public/camp.js`, `campRunSelect`): until Phase 3 ships,
   append *"This cannot be undone."* — right now the delete confirm advertises undo
   while the genuinely destructive merge says nothing. After Phase 3, flip it to
   *"This can be undone from the log tab."* Note `public/camp.js` loads in `<head>`
   with no defer — top-level `document.body` use breaks everything (AGENTS.md #1).
3. **Person-delete should end the target's sessions** (`DELETE FROM sessions WHERE
   person_id = ?` for real accounts) and — decision — **auto-rejoin stays** (doing
   something on a fest means you're going; that's the app's soul). The
   double-pledge hazard it created is closed by the engine's domain guards, not by
   nerfing auto-rejoin.

---

## 6. Implementation phases

Each phase is shippable alone, in order. **After each phase run the verification
harness (§7) and drive the UI in a real browser** — AGENTS.md is explicit that
curl alone proves nothing about client behavior.

- **Phase 0 — safety valves (no schema):** §5 items 1–3. Also port the §7 harness
  into `scripts/verify-undo.sh` (checked in, documented at the top of the script).
- **Phase 1 — engine:** migration 005 (`effects_json`), `src/lib/effects.js`,
  `undoAction` integration with legacy fallback, batch atomicity, skipped-report
  dialog in the log route. Convert create/delete/update/bail/person-delete/ghost-add
  emission sites to also write effects (each site is a small change: build the
  effects array next to the existing `logAction` call). Includes the update-diff
  fix (changed columns only) and the auto-note inclusion (G10).
  **Fixes: G2, G4-silent-half, G5, G9, G10, G11, G12.**
- **Phase 2 — domain guards:** the `duplicate_active` checks for pledges/seats in
  the engine. **Fixes G3's corruption** (the double-pledge repro in §7 must now end
  with the restore skipped + XP dialog explaining it).
- **Phase 3 — reversible merge:** migration 004, `mergePeople` rewrite, absorb
  logging + dead-ghost skip, sign-in merge-chain resolution, `loadPerson` guard,
  confirm-copy flip. **Fixes G1, G4, G7, G8.**
- **Phase 4 — polish:** log-tab annotation for partially-undone entries (store the
  skipped summary in the `undo` entry's `after_json` and render a hint), admin
  "(merged into X)" note, double-undo idempotency note (`UPDATE audit_log SET
  undone_at = ... WHERE id = ? AND undone_at IS NULL` as the batch's first
  statement).

Commit per phase with the verification evidence in the commit message.

---

## 7. Verification harness (this is how the audit found everything)

Local setup (see AGENTS.md D1 notes): `npm run db:migrate:local && npm run
db:seed:local`, apply `migrations/*.sql` with `wrangler d1 execute camp-planner-db
--local --file=...`, then `npx wrangler dev --ip 127.0.0.1 --port 8787`.

Drive with curl + inspect sqlite directly (the local DB file lives at
`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`; open read-only:
`sqlite3 'file:<path>?mode=ro'` or python). Sign-in is just
`curl -c jar.txt -X POST /signin --data-urlencode "name=X" --data-urlencode
"next=/f/1/stuff"` (302 = success; an EXISTING name via non-htmx curl signs in
directly — no popup).

Re-run each numbered scenario; **expected outcomes after all phases:**

1. **Bail undo (G2):** pledge (`POST /items/1/pledge qty=2`), claim seat
   (`POST /cars/1/seats/claim`), bail (`POST /f/1/people/<id>/bail`), undo the bail
   entry. → membership `bailed_at NULL` **and** pledge + seat `deleted_at NULL`.
2. **Ghost delete → undo (regression):** add ghost, seat, check, delete, undo. →
   everything restored (this already passes today; it must keep passing, now via
   effects).
3. **Redo ping-pong (regression):** undo, then the new undo entry, repeatedly. →
   state toggles cleanly every time.
4. **Double-pledge resurrect (G3):** pledge 3, get person-deleted, (same cookie)
   pledge 5, undo the delete. → old pledge **stays hidden**, `skipped` reports
   `duplicate_active`, XP dialog shown, item shows ONE pledge (5).
5. **Merge two reals (G1):** two accounts vote the same item, merge B→A. →
   B's person row soft-deleted (`deleted_at` set, `merged_into=A`), B's vote
   `deleted_at` set (NOT missing), B's sessions gone, audit attribution unchanged,
   log entry HAS an undo button. **Then undo the merge** → B's row live again,
   vote back, reassigned rows back on B; B can sign in as "Dupe B" again.
6. **Merge then person-delete then un-merge ordering:** merge B→A, delete A from
   the fest, undo the merge, undo the delete — and the reverse order. → no crashes,
   guards skip anything genuinely conflicting, dialogs say so, no row ends up
   attributed to the wrong person. (This is the "does it cleanly split" case.)
7. **Stale update (G5):** edit item qty 3→6, then 6→8, undo the FIRST edit. →
   qty stays 8, skip reported (`changed_since`). Undo the SECOND edit → qty 6.
8. **Cross-fest forgery (G6):** create fest 2, `POST /f/2/log/<fest1-entry>/undo`.
   → 404, nothing changes.
9. **Absorb (G8):** ghost "Casper" with seat; real "Casper" signs in on the fest →
   absorb IS logged and reversible. Then: delete a ghost first, sign in with its
   name → **no absorb** (dead ghost skipped), fresh account created.
10. **Browser pass (AGENTS.md rule #3):** with Playwright/Chromium, click an
    actual undo button in the log tab, see the partial-restore XP dialog render and
    close; confirm no console errors. (Playwright launch:
    `executablePath: '/opt/pw-browsers/chromium'`-style path if sandboxed, stub CDN
    requests for htmx if the environment blocks them.)

---

## 8. Out of scope (deliberately)

- **Permissions** — anyone signed-in may undo anything; that's the app's stated
  trust model ("everything audited + undoable"), unchanged here.
- **Name-reclaim trust model** ("Yes, That's Me") — separate product question.
- Making non-reversible informational entries (arrival day, checklist toggles)
  reversible — fine as-is; note `checklist_checks` toggle logs `entity_id = task
  id` not check id, so if anyone ever flips it to reversible, fix that first.

## 9. Style & voice reminders for the implementer

- All new dialog/UI copy in authentic Windows XP voice (AGENTS.md "Conventions").
- Comments explain *why*, matching the codebase's density.
- No backticks and no unescaped-backslash regexes may be added to string-embedded
  JS/CSS (mostly historical now that `public/camp.js`/`public/retro.css` are real
  files — but the rule still matters for `hx-*` attribute snippets).
- Soft-delete everywhere; after this plan, *literally* everywhere — `people` was
  the last hard-DELETE in the app and this plan removes it. Never add a new one.
