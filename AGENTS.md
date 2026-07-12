# AGENTS.md — hard-won notes for working in this repo

Camp Planner: Cloudflare Worker + Hono, **server-rendered HTML + HTMX**, D1 (SQLite).
No build step, no SPA. See `PLAN.md` for product intent. Read this before touching
rendering, the sign-in flow, or the DB — everything here bit us at least once.

## 🎨 Design language: every feature is a fake Windows XP program

This is the soul of the site. It is not "a website with an XP skin" — it's an **XP
desktop** (Bliss wallpaper, taskbar, Start menu, desktop icons, Rover) where each
feature ships as its own **distinct, recognizable XP-era application**:

- Meeting spot → **Microsoft Streets & Trips** (menu bar, toolbar, directions pane,
  real map pane, status bar with coordinates) — `meetBanner()` in `rides.js`
- Comments → **MSN Messenger** chat windows (`src/render/msn.js`, real 2003 emoticons)
- Cars → a **"Car Pool"** program window; rosters → **Explorer detail listviews**
- Admin → an **MMC console**; Settings → **Control Panel** with group boxes
- Sign-in nags/tips → **Rover the Search Companion**; errors → real dlg-* icons; the
  BSOD easter egg is a feature, not a bug

**When building something new, pick a period program and replicate its anatomy**:
title bar (via `xpCaptionBtns()`), menu bar, toolbar with icon buttons, sunken white
work area, status bar with plausible-looking cells. Then make **only the controls
that matter live** — everything else is inert scenery (`aria-hidden`,
`span { pointer-events: none }`, e.g. Back/Forward/Print in Streets & Trips; the
one live menu item is Edit). Users love discovering which parts work. Icons come
from the local XP icon pack via `scripts/make-xp-icons.sh` — add a `resize` line
there (source of truth), never hand-copy PNGs. Plenty of good icons remain unused
in `~/Downloads/Windows XP High Resolution Icon Pack/`.

Real data beats fake data *inside* the fake chrome: the Streets & Trips map pane is
a live OpenStreetMap embed; the status bar shows the real lat/lon parsed from the
Google Maps link. That contrast (authentic 2003 chrome, working 2026 internals) IS
the joke — lean into it.

## 🗺️ Map of the code

- **`public/retro.css`** — ALL the CSS (Luna theme). **`public/camp.js`** — ALL the
  client JS. Both static, loaded in `<head>`; camp.js deliberately has **no `defer`**.
  Their URLs carry `?v=<deploy version>` (see Caching below).
- **`src/render/layout.js`** — page shell (`renderPage`), taskbar, Start menu, ticker,
  Rover, asset versioning. `renderPage` takes `pre:` for windows that render OUTSIDE
  the main app window (Streets & Trips sits above Car Pool — two programs on the desktop).
- **`src/render/popup.js`** — shared window components (below). **`src/render/msn.js`**
  — the MSN chat window. **`src/routes/*.js`** — one file per tab/feature.
- **`src/lib/`** — audit/undo (`audit.js`, `effects.js`), people/ghosts (`people.js`),
  sign-in guard (`guard.js`), comments, notify, **API budgets (`budget.js`)**.

## ☠️ Gotchas that WILL waste your time

1. **`document.body` is `null` at the top level of `camp.js`** (script runs in
   `<head>`). A top-level `document.body.*` throws and silently kills every listener
   declared after it. Bind global listeners to `document`; `document.body` inside
   functions that run later is fine.

2. **Hono `html\`\`` escapes interpolated quotes.** Building a whole attribute as a
   string — `` ${id ? `id="${id}"` : ''} `` — renders `id=&quot;…&quot;`: a dead
   attribute that LOOKS fine. Keep quotes as static template text (`id="${id}"`) or
   nest `html\`id="${id}"\``. (`hx-vals='${JSON.stringify(...)}'` in single quotes is
   safe — escape/un-escape round-trips.)

3. **htmx events bubble: a form's `hx-on::after-request` fires for its children's
   requests too.** A live-search input inside the form completes a request → the
   form's "close on success" handler runs → popup vanishes mid-typing. Guard with
   `event.detail.elt === this`.

4. **Green curl ≠ working feature, `el.click()` ≠ a real click, and desktop
   Chrome ≠ the phone.** curl proves markup only; programmatic `.click()` bypasses
   pointer events, hit-testing, and pointer capture; and **Chris mostly uses the
   site from an iPhone** — an entire class of bugs (iOS `vh`, Safari font
   rejection, touch capture, stale-cache JS) is invisible in every check we can run
   here. Anything touching fonts, viewport sizing, touch, or caching isn't done
   until it's been looked at on the phone (via Tailscale to the dev server).
   Corollary: the browser-automation tool's clicks can land offset from computed
   coordinates — confirm where a click actually landed (log a capture-phase
   handler / `elementFromPoint`) before diagnosing from it. A tool near-miss once
   got dressed up as a "users fat-finger the ✕" theory; the real bug was pointer
   capture + stale JS (gotcha 5). Verify the mechanism, don't narrate one.

5. **Never start a drag / `setPointerCapture` from an interactive element.** A
   captured pointer retargets the follow-up click to the capture target, silently
   eating the button's click. This (via stale cached JS that didn't know renamed
   button classes) is what actually killed the popup ✕ on the phone. The title-bar
   drag handler excludes `button, a, input, select, label` **by tag** so it
   survives class renames.

6. **`flex-basis: 100%` will NOT wrap** if row siblings have `flex-basis: 0` —
   wrapping is decided on pre-grow sizes. Use `flex: 0 0 100%`. Related: the car/item
   card edit toggle is deliberately **checkbox + label + `form=`-linked submit
   button** (three flex siblings), NOT `<details>` — `display: contents` on details
   doesn't flatten into flex in Chrome. Don't "simplify" it back.

7. **Workers forbid async I/O and randomness in module scope.** A top-level
   `crypto.randomUUID()` / `fetch()` crashes the whole worker at startup
   ("Disallowed operation called within global scope"). Lazy-init inside handlers.

8. **Never run two `wrangler dev` instances of this repo.** They share
   `.wrangler/state` D1 sqlite files; lock contention makes every request hang —
   which looks like a network/Tailscale problem, not the real cause. Check
   `lsof -iTCP:8787 -sTCP:LISTEN` before starting one.

9. **Web fonts: never strip the name table, and a changed font needs a new
   filename.** `pyftsubset --name-IDs=''` saves ~1KB and produces a font iOS
   Safari **silently rejects** — desktop Chrome tolerates it, so everything looks
   fine in every check except on the actual phone (see gotcha 4), and the color-
   emoji fallback masks the failure instead of showing tofu. Graceful fallbacks
   hide regressions: when a check is cheap (`document.fonts.check`), use it while
   verifying. `/fonts/*` is cached immutable for a week, so a rebuilt font MUST
   ship under a new filename + updated `@font-face` URL (see
   `scripts/build-unifont-emoji.sh`).

## 🧱 Shared XP components — use these, don't hand-roll

All in `src/render/popup.js` unless noted:

- **`xpCaptionBtns({ min, max, onClose })`** — THE min/max/✕ buttons for every title
  bar. CSS-drawn glyphs (`.xp-caption-btn` in retro.css), pixel-identical everywhere.
  Decorative spans by default (click-through); pass `onClose` for a real ✕. There
  were once five hand-rolled copies with three different glyph characters — never again.
- **`xpPopup({ title, body, id, wide, cls, onClose })`** — floating draggable XP
  window into `#popup-layer` (`hx-swap="beforeend"`). Same `id` = reopen replaces.
- **`xpDialogPopup({ title, icon, message, buttons, id, big, onClose })`** — classic
  message box (icon + message + buttons). Use for confirms — server-render it so
  names in the message can't be spoofed (see car passenger removal).
- **Group boxes**: plain `<fieldset><legend>` — retro.css styles them Luna-etched;
  `.cp-legend-ico` puts a 16px icon in the legend. **Task headers**: `.meet-task-head`
  (white wizard band: icon + bold question + explanation) — copy for dialog-y forms.
- **`.xp-listview`** — Explorer detail list (header gradient + `.lv-link` header
  actions + zebra rows). **`.pick-list` / `.pick-row`** — click-to-pick result rows.
- **`.dialog-buttons` in `.meet-form`** is position:sticky at the popup bottom
  (property-sheet style, always reachable) — copy for any long form in a popup.

**Popup mechanics** (`camp.js`): placement/cascade runs on `htmx:afterSwap`; a popup
stuck at the viewport top-left means that handler didn't run (see gotcha 1).
`closePopup(el)` / `closeAllPopups()` / `popupTop()`. The name-taken sign-in warning
shows the pattern for "a second window that takes over": server sets
`HX-Retarget`/`HX-Reswap` to `#popup-layer`, client stashes the modal
(`campStashSignin`/`campRestoreSignin`) instead of stacking.

**Mobile (≤600px) rules**: CSS overrides JS popup placement entirely (`left/right
12px !important`, `top: 48px !important`, full-width). Body height caps use **`dvh`,
never `vh`** — iOS `vh` includes the collapsed toolbar, which pushes bottom buttons
off the visible screen. Caption buttons grow to 30×27 (21px is well under Apple's
44pt touch-target guideline). The Streets & Trips status bar drops its stop-count
and coordinate cells.

## 🏗️ Server patterns

- **Every mutation goes through `logAction`** (`src/lib/audit.js`). It auto-creates
  membership ("doing anything on a fest joins you") — one chokepoint, don't sprinkle
  join logic in routes.
- **Undoable mutation = `logAction` with effects** (`src/lib/effects.js`): generate
  `const stamp = sqlNow()` **once**, write it into the soft-delete column, pass
  `reversible: true, effects: [...]` — `createEffect` / `deleteEffect` /
  `fieldEffects(t, id, before, after)`. Batch = N effects on one entry. **The stamp
  in the row and in the effect must be byte-identical** or undo silently skips
  (`changed_since`). Never call `sqlNow()` twice in one action.
- **No-op saves are not updates**: if `before` equals `after`, skip the UPDATE and
  the `logAction` entirely (no audit spam, no ticker noise) — see `POST /f/:id/meet`.
- **Ghost people** (`src/lib/people.js`): `is_placeholder=1`, synthetic unique
  `normalized_name`, `placeholder_key` = normalized display name; absorbed into the
  real account on first login. **Person delete = soft-hide manifest**
  (`deletePersonFootprint`) — never hard-DELETE people (FKs everywhere, and undo
  restores the whole footprint from the manifest).
- **Signed-out guards**: window-opening GET routes get
  `if (needsSignin(c)) return signinModalResponse(c)` — the button pops the sign-in
  modal via HX-Retarget instead of a form that fails on POST. Also guard any endpoint
  that triggers **outbound API calls** (search/lookup), or anonymous traffic burns quota.
- **Third-party APIs must be $0** (Chris's rule). Pattern (`src/lib/budget.js`):
  bump-then-check a **monthly** D1 counter (`api_usage`, 'YYYY-MM') before every
  outbound call — monthly because usage is bursty and free tiers are monthly. On top:
  GCP quota overrides as catastrophe backstops (Places SearchText: 160/day, 30/min;
  free tier 5,000/mo), key restricted to the one API, cheap request guards (min query
  length, length cap). Budget spent → polite XP notice; the free path (parsing pasted
  links) keeps working. Google Maps parsing needs no API: name from `/maps/place/X/`,
  address from the `!2s…` token, coords from `!3d…!4d…` (or our own `#lat,lon`
  fragment convention on links we build — Google never sees fragments). **Exact
  addresses only — never reverse-geocode approximations** (people drive to these).
- **Multi-select remove mode** (`camp.js`): button reveals per-row checkboxes
  (`.selecting` class), delegated handlers keep a count, confirm via server-rendered
  `xpDialogPopup`. Two instances (ppl tab, car roster) — copy, don't invent.
- **Personalize where cheap**: the Streets & Trips "1: Depart from …" leg reads the
  viewer's own car's `leaving_from` (`viewerDepartFrom`), falling back to "home".

## 🗄️ D1 / dev / deploy / caching

- **Migrations**: next `NNN_name.sql` in `migrations/` (filename order = apply
  order); keep each one small (a half-failed multi-statement file can't re-run);
  mirror every change in `schema.sql` (fresh installs run schema.sql only) and keep
  the soft-delete (`deleted_at`) convention. Local:
  `wrangler d1 migrations apply camp-planner-db --local`. **Prod: CI applies on push
  to main, then deploys** (`.github/workflows/deploy.yml`) — migration FIRST, then
  code. Hand-applied migrations must be back-filled in
  `scripts/baseline-migrations.sql`. Never park scratch SQL in `migrations/`.
- **Local D1 is keyed off `database_id`** in wrangler.toml — if it changes, dev
  points at a fresh empty DB (`no such table`); old data is still in
  `.wrangler/state/v3/d1/…/<hash>.sqlite`, recoverable via `scripts/restore-local-db.py`.
- **Asset caching**: `public/_headers` sets `Cache-Control: no-cache` on
  camp.js/retro.css — browser revalidates each load, ETag makes it a 304 unless the
  file changed. That's the whole freshness story: standard, sufficient at this
  scale, no fingerprints, no build step. (A `?v=<deploy-id>` scheme was tried and
  removed — redundant next to no-cache, and deploy-id isn't a content hash so it
  forced pointless re-downloads. If assets ever need `immutable` caching, do real
  content-hashing; don't resurrect the deploy-id stamp.) The art gets week-long
  caching — icon changes can be a week stale for old visitors; rename the file if
  a change must land instantly.
- **Secrets** are `*_API_KEY` names (`wrangler secret put`, local in `.dev.vars`,
  gitignored). Google key: GCP project `southern-sol-496313-g7`, key
  `camp-planner-places`, restricted to Places API (New).
- Prod route: **`camp.cuuush.com/*`** (zone `cuuush.com`).

## 🗣️ Copy voice: authentic Windows XP — NO EXCEPTIONS

Write **every** user-visible string as if it ships inside the OS: button labels,
titles, confirms, hints, placeholders, empty states, errors, notifications, log
summaries. Ask "would this exact wording have shipped in Windows XP?" — rewrite
until yes.

- **Title Case buttons**: "OK", "Cancel", "Post Car". A trailing `…` on a button
  that opens a dialog is authentic ("Add…", "Browse…"); a leading ＋/emoji is not.
- **Confirms**: "Are you sure you want to…". **Progress**: "Please wait while…".
  **Empty states**: "There are no X in this view." **Spelling**: "e-mail".
- **Labels** end with a colon ("Search for:", "Place:"). **Dialog headers** ask the
  Search Companion question ("Where is everyone meeting up?") then explain.
- **Placeholders are SAMPLE VALUES**, never instructions: `Redmond, WA`,
  `9:00 AM`, `Thu`, `Type their name`. No meta-hints like "blank = idk".
- **Help/tips**: the cheery "click **Start**, and then click…" voice (see `dogTip`).
- Fun stays fun (tab names, Rover, BSOD) — but frame jokes in XP phrasing, never
  lowercase internet-casual.

## 🔤 Pixmoji: how emoji get pixelated (and how to debug when they don't)

Client JS (`pixmojify` in camp.js) wraps emoji text in `.pixmoji` spans; CSS gives
those a pixel-font stack: **UnifontExMono** (jsDelivr, covers emoji ≤ Unicode 11)
→ **UnifontEmoji16** (self-hosted `/fonts/unifont-emoji16a.woff2`, plane-1 subset
of GNU Unifont 16, fills every 2019+ emoji — mirror, wood, coin…) → system.
`window.PIXMOJI_RANGES` (from `src/render/pixmoji-coverage.js`, generated by
`scripts/gen-pixmoji-coverage.mjs`) gates wrapping so uncovered emoji stay native
instead of tofu. **"Emoji X isn't pixelated" checklist**: (1) is it inside a
`.pixmoji` span? if not → regex/coverage/`pixmojify` didn't run; (2) which font
owns that codepoint (new emoji = the gap-filler); (3) did that font load —
`document.fonts.check('16px UnifontEmoji16', '🪞')`; (4) **check on the phone** —
Safari rejects fonts Chrome accepts (gotcha 9), and the color fallback hides it.

Code comments explain *why*. Soft-delete everywhere; everything audited and undoable.
