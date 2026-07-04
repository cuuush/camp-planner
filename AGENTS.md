# AGENTS.md — hard-won notes for working in this repo

Camp Planner: Cloudflare Worker + Hono, **server-rendered HTML + HTMX**, D1 (SQLite).
No build step, no SPA. See `PLAN.md` for product intent. This file is the stuff that
bit us — read it before touching rendering, the sign-in flow, or the DB.

## 🗺️ Where the frontend lives

- **`public/retro.css`** — ALL the CSS (the XP/Luna theme). Served statically.
- **`public/camp.js`** — ALL the client JS (popups, select-mode, pixmoji, clock,
  Start menu, confetti, BSOD…). Served statically, loaded in `<head>` *without*
  `defer`. Historically these were giant template-literal strings inside
  `layout.js` (`RETRO_CSS` / `CONFETTI_SCRIPT`) — old comments may still say so.
- **`src/render/layout.js`** — the page shell (`renderPage`), taskbar/Start menu,
  ticker, Rover. Server-side markup only; no CSS/JS blobs.

## ☠️ Gotchas that WILL waste your time

### 1. `document.body` is `null` at the top level of `public/camp.js`
Its script tag is in `<head>` (before `<body>` is parsed). So any
**top-level** `document.body.addEventListener(...)` / `document.body.X` **throws**,
and the throw silently halts the *rest* of the script — meaning every listener
declared after it never registers. This cost us a long debugging session (popups
rendered top-left, merge/delete select-mode was dead) because it *looked* fine.
- Bind global listeners to **`document`**, not `document.body`. HTMX/DOM events
  bubble to `document`. `document.body.*` inside a function that runs later (e.g. a
  `DOMContentLoaded` callback or a click handler) is fine — only top-level use breaks.

### 2. curl only proves the HTML is present, NOT that the JS runs
Every "verified via curl" check in this repo confirms markup/headers only. It will
happily pass while the client JS is throwing in the browser (see #1). If a change is
behavioral (drag, select-mode, popups, stash/restore), a green curl is necessary but
**not sufficient** — reason about the JS actually executing, or ask the user to click it.

## 🧱 Shared UI components (`src/render/popup.js`)

Prefer these over hand-rolling dialogs — they're the "nice window" look and are
already wired for dragging + centering.

- **`xpPopup({ title, body, id, wide, cls, onClose })`** — a floating, draggable XP
  window. Rendered into `#popup-layer` via `hx-swap="beforeend"`. `onClose` is a JS
  snippet appended to the ✕ handler. `id` (→ `data-popup-id`) makes re-opening replace
  rather than duplicate.
- **`xpDialogPopup({ title, icon, message, buttons, id, big, onClose })`** — the
  reusable classic-XP **message dialog** (icon + message + button row). `icon` is a
  path under `/public` (`/notify.png`, `/question.png`). `big` doubles the icon.
  `buttons` is caller HTML; each button carries its own `onclick`/`hx-*`. Uses its own
  `.xp-dialog-prompt` (vertically **centered** icon), deliberately distinct from the
  pledge modal's `.pledge-prompt` (bottom-aligned) — don't merge them.

### Popup mechanics (in `public/camp.js`)
- Popups live in `#popup-layer` (fixed, `pointer-events:none`; children re-enable it).
- The `htmx:afterSwap` handler (bound to `document`) **centers the first popup and
  cascades stacked ones**, sets z-index, focuses the first input. A popup with no
  `left/top` falls to viewport top-left — so if it's mis-positioned, the positioning
  handler didn't run (usually gotcha #1 above).
- `closePopup(el)`, `closeAllPopups()`, `popupTop()` are the helpers.

### The name-taken sign-in warning = "stash & restore", not stacking
When you submit a taken name, `POST /signin` (htmx branch) returns
`nameTakenWarning()` (a `xpDialogPopup` using `/notify.png`) **retargeted to
`#popup-layer` beforeend** via `HX-Retarget`/`HX-Reswap` headers. It does NOT sign
you in — reclaim only happens on "yep, that's me" (→ `/signin/reclaim`).
- Instead of stacking on the sign-in modal, it **stashes** it: `campStashSignin()`
  hides `#signin-modal-overlay` when the `name-taken` popup is placed;
  `campRestoreSignin()` brings it back (with typed input intact) on ✕ / "pick another".
- `campSigninBackdrop()` also refuses to dismiss the modal when a popup is open or
  when the name/email fields have text.
- Pattern to copy for any "second window that takes over": server sets
  `HX-Retarget`/`HX-Reswap`, client uses `data-popup-id` + a stash/restore pair.

## 🏗️ Architecture patterns worth knowing

- **Membership is auto-created in `logAction`** (`src/lib/audit.js`). Every mutation
  flows through `logAction`; if it has a `festivalId` + signed-in person and the action
  isn't `bail`, `ensureMembership` runs. So "doing anything on a fest joins you" is one
  chokepoint — don't sprinkle join logic into routes. Signing in on a fest page and the
  explicit join button also call `ensureMembership*`.
- **Placeholder ("ghost") people** (`src/lib/people.js`): people manually added by name
  who haven't logged in. They're real `people` rows with `is_placeholder=1`, a
  **synthetic unique `normalized_name`** (so they can't sign in / collide), and
  `placeholder_key` = normalized display name. On login, `absorbPlaceholders()` merges
  any ghost with a matching `placeholder_key` into the real account. `mergePeople()`
  reassigns all associations and dedupes UNIQUE conflicts (real person always wins).
- **Reversible person delete via manifest** (`deletePersonFootprint` + `purgeFootprint`
  / `restoreFootprint`): deleting a person **destroys nothing** — it soft-hides their
  whole fest footprint (pledges/seats/votes/comments/car/checks/membership) and records
  a manifest of exactly which rows flipped. `audit.js` has a special `entity_type ===
  'people'` branch in revert/reapply that restores from the manifest (stored in BOTH
  `before_json` and `after_json`). This is how "undo restores literally everything" works.
- **Signed-out → immediate sign-in**: guard the *window* GET routes (e.g.
  `/cars/:id/add-window`, `/f/:id/people/add-window`) with `signinModalResponse` so the
  button pops the modal via `HX-Retarget` instead of showing a form that fails on POST.
  For pure client-side buttons (merge/delete `onclick`), branch on `c.get('person')` and
  render an `hx-get="/signin/modal"` trigger when signed out.
- **One sign-in UI.** The old full-page `signinForm` was deleted; `GET /signin` now
  renders `modalFormMarkup` too. The header link + dog both `hx-get="/signin/modal"`.
- **`hx-vals='${JSON.stringify(...)}'`** inside an `html\`\`` single-quoted attribute is
  safe — Hono escapes it, the browser un-escapes entities, HTMX sees valid JSON.

## 🗄️ D1 / dev / deploy gotchas

- **Local D1 is keyed off `database_id`.** `wrangler dev --local` picks its miniflare
  sqlite file from the `database_id` in `wrangler.toml`. If that id changes (e.g. a
  deploy sets the real one), local dev silently points at a **fresh empty DB** and you
  get `no such table`. The old data still lives in the old-id sqlite under
  `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`. `scripts/
  restore-local-db.py` regenerates named-column INSERTs from the old file (needed
  because `items.description` was appended via ALTER TABLE, so positional dumps
  misalign).
- **Migrations live in `migrations/`**; locally apply with
  `wrangler d1 execute camp-planner-db --local --file=migrations/NNN.sql` (or
  `wrangler d1 migrations apply camp-planner-db --local`, which tracks what ran).
  Keep `schema.sql` in sync for fresh installs.
- **Writing a new migration:** next `NNN_name.sql` number in `migrations/` —
  lexicographic filename order IS the apply order. Prefer idempotent statements
  (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); `ALTER TABLE ADD
  COLUMN` can't be idempotent in SQLite and that's fine — wrangler's bookkeeping
  runs each file exactly once, but it means a half-failed multi-statement file
  can't just be re-run, so keep each migration small. Update `schema.sql` with
  the same change (fresh installs run schema.sql, never the migrations), and
  mirror new tables' soft-delete (`deleted_at`) convention.
- **Prod migrations are applied by CI** (`.github/workflows/deploy.yml`): on push to
  main it runs `d1 migrations apply --remote` and only deploys the worker if that
  succeeds. Wrangler tracks what's applied in the `d1_migrations` table; migrations
  that were applied BY HAND before CI existed are back-filled by
  `scripts/baseline-migrations.sql` (add a filename there if you ever hand-apply
  one again). Every .sql file in `migrations/` gets picked up — never park scratch
  SQL in that folder.
- **Deploy order for additive migrations: migration FIRST, then code.** Adding columns
  / renaming a label is safe against the old code still running; deploying new code that
  references not-yet-existing columns 500s. The workflow encodes this order.
- **Deleting a person row hits FK constraints** (`name_reclaim_log`, `checklist_checks`,
  `seats`, `memberships`, `sessions`, `audit_log`, …). Clear children before the parent,
  or (better) prefer the soft-hide manifest approach above.
- Prod route is **`camp.cuuush.com/*`** (zone `cuuush.com`), not `track.*`.

## Conventions
- **UI copy voice: authentic Windows XP.** System chrome — dialogs, popups, the
  Control Panel, confirms, hints, placeholders, empty states — reads like real XP
  UI text: Title Case buttons ("OK", "Cancel", "Apply", "Send Error Report"),
  "Are you sure you want to…" confirms, "Please wait while…" progress text,
  "There are no X in this view" empty states, "e-mail" with the hyphen, and help
  copy in the cheery "click Start, and then click…" voice (see `dogTip` in
  `layout.js`). Fun is still welcome where it's fun — tab names, "i'll bring
  this", "✔ i'm going!", Rover and the BSOD easter egg stay — but frame the joke
  in XP phrasing rather than lowercase internet-casual.
- Code comments explain *why*.
- Emoji in UI text render via the `.pixmoji` pixel font; `font-variant-emoji: text`.
- Soft-delete everywhere (`deleted_at`); everything audited + undoable (`reversible`).
