# AGENTS.md — hard-won notes for working in this repo

Camp Planner: Cloudflare Worker + Hono, **server-rendered HTML + HTMX**, D1 (SQLite).
No build step, no SPA. See `PLAN.md` for product intent. Read this before touching
rendering, the sign-in flow, or the DB — everything here bit us at least once.

## 🚪 Start here (you are a fresh copy of me — read this first)

**What it is.** A private tool for a group of friends going to a music festival
together: who's coming, what everyone's bringing, who's driving, and which sets to
catch. Small audience, phones-first, real people who will actually use it. It is
dressed head to toe as **Windows XP** — that is the point, not decoration.

**The 60-second mental model.**

1. A request hits `src/index.js` → `src/app.js`. Middleware loads the session person
   (one query) and then routes fall through `src/routes/*.js`.
2. A route awaits `loadFestival(c)`, builds its body as an **unawaited promise**, and
   hands it to `renderPage()` (`src/render/layout.js`), which renders the whole XP
   desktop shell around it — taskbar, Start menu, desktop icons, window chrome, Rover.
3. The response is a complete HTML page. Every interaction after that is HTMX
   swapping a **fragment** the same route module renders. There is no client state,
   no hydration, no JSON API. `public/camp.js` is progressive enhancement only.
4. Every mutation is a soft delete plus a `logAction()` audit row, and most are
   undoable via the effects engine.

**Where things live.** `src/routes/` = one file per XP "program" (stuff, people,
rides, schedule, mine, log). `src/lib/` = the shared machinery (session, audit,
effects, people/ghosts, email, budget). `src/render/` = the shell and reusable XP
widgets. `public/retro.css` + `public/camp.js` are the *only* two frontend files.

**How to run it.** `npm run dev` (Chris usually already has one running — **do not
kill or restart his dev server**, ask him to). Local D1 is throwaway; test against it
freely. The `/verify` skill builds and drives the app end to end. Chris tests UI in
the browser himself — ship the code and report rather than driving a browser to
prove it.

**The three things that will bite you first**, in order: passing `body` **awaited**
into `renderPage` (silently costs a round trip, nothing fails); calling `sqlNow()`
twice in one mutation (undo silently skips); and writing copy that doesn't sound like
Windows XP. All three have their own sections below.

**Reading order for a cold start.** This file's "Map of the code" → "Server patterns"
→ "Gotchas". Then open `src/routes/items.js` — it is the most worked-over route and
the best worked example of every pattern here (batched loads, fragment rendering,
effects, optimistic UI).

**Keep this file current.** It is the accumulated memory of everyone who has worked
here, and it is the difference between a copy of me being useful in five minutes and
rediscovering a footgun the hard way. When something surprises you, costs you an
hour, or you make a decision a future copy would otherwise second-guess — write it
down here, in the section it belongs to, in the same voice: what happened, why, and
what to do instead.

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
there (source of truth), never hand-copy PNGs. The script **only builds what's
missing**: `sips` re-encodes on every run and its output isn't byte-stable, so a
full rebuild rewrites every PNG and turns a one-icon swap into a dozen bogus
"modified" files. Force one with `./scripts/make-xp-icons.sh <name>` (or `FORCE=1`
for all). It also means the script runs fine without the source pack on disk.
Plenty of good icons remain unused in `~/Downloads/Windows XP High Resolution Icon
Pack/` — and the names are literal, so shop by concept: Cars uses `Activation`
(XP's product-key icon = keys).

**A live control cannot look like the scenery.** Because so much XP chrome here is
deliberately inert, the *authentic* place for a control is often the wrong place for
it: a toolbar toggle is what Explorer would really use for a view mode, but in a
window full of dead toolbar buttons it reads as more scenery, and it's a ~20px tap
target on the phone this is mostly used from. Pick the most XP-authentic control
*that is obviously live and thumb-sized* — a checkbox with a full-width label, a
Luna push button — and put it where fingers go, not where a mouse-era toolbar would.
**And the same drawn control can mean two different things in two windows** — the
tick box in What I'm Bringing is your own packing, the one on an item in Stuff is
the promise to bring it. When that happens, one of them has to say so in prose; XP
would have put a line of Help and Support text under the list, so we do too.
On a fully covered Stuff item, a person who has not pledged sees no empty box in the
collapsed list; opening the card reveals one in the usual right-hand header position.
That box means "bring more" and always opens the shared quantity dialog — there is
no remaining amount for a one-click pledge to infer.

Real data beats fake data *inside* the fake chrome: the Streets & Trips map pane is
a live OpenStreetMap embed; the status bar shows the real lat/lon parsed from the
Google Maps link. That contrast (authentic 2003 chrome, working 2026 internals) IS
the joke — lean into it.

## 🗺️ Map of the code

- **`public/retro.css`** — ALL the CSS (Luna theme). **`public/camp.js`** — ALL the
  client JS. Both static, loaded in `<head>` in that order: **stylesheet first, then
  both scripts `defer`red**, so the render-blocking resource is discovered first and
  a long page doesn't hold its parse open for JS. Freshness is `public/_headers`
  (`no-cache` + ETag), NOT a URL stamp — see Caching.
- **`scripts/`** — besides the build/seed tooling, four checks worth re-running after
  touching the stuff tab or the shell: `check-stuff-controls.mjs` (asserts every item
  card's check box/like button against the rules, signed in AND out — pass a cookie
  as argv[2]), `check-stuff-order.mjs` (the three groups are consistent and
  partly-pledged items rank first),
  `page-weight.mjs` (ranks what's actually filling a page), `find-dead-frontend.mjs`
  (unreferenced `camp.js` functions + CSS classes nothing emits).
- **`src/render/layout.js`** — page shell (`renderPage`), taskbar, Start menu,
  desktop icons, Rover, tab themes. `renderPage` takes `pre:` for windows that render
  OUTSIDE the main app window (Streets & Trips sits above Car Pool — two programs on
  the desktop). **Pass `body`/`pre`/`floating` UNAWAITED** — see Server patterns.
  htmx is **vendored** (`/htmx-1.9.12.min.js`, cached immutable), not a CDN link:
  version lives in the filename, so upgrading = new file + new `<script src>`.
- **`src/render/popup.js`** — shared window components (below). **`src/render/msn.js`**
  — the MSN chat window; two shapes, inline `<details>` (items/cars) and `windowed`
  (the Schedule tab pops it out as a real `xpPopup`). **`src/routes/*.js`** — one
  file per tab/feature.
- **`src/lib/`** — audit/undo (`audit.js`, `effects.js`), people/ghosts (`people.js`),
  sign-in guard (`guard.js`), comments, notify, **API budgets (`budget.js`)**.
  Sign-in is a **full-page redirect** (it must work without JS), so it resumes what
  you were doing via query params on the destination — `?expand=item-5` (server
  reopens that card; `rides.js` does the same with `car-N`) and `?pledge=5` (client
  resumes the tick). They are plumbing, **not** for humans: `campTidyUrl()` strips
  both with `replaceState` right after `campAutoOpenPledge` has read them, so they
  never linger in the address bar. Keep that ordering, leave the `#item-5` anchor
  alone (`:target` styling reads it), and don't strip anything else — `?sort=` is
  the user's own. Covered by `scripts/test-tidy-url.mjs`.
- **Schedule tab** — `routes/schedule.js` (grid, day buttons, import, edit) +
  `lib/schedule.js` (time math; minutes-from-midnight, after-midnight = 1440+),
  `lib/scheduleParse.js` (vision-parse a poster via OpenRouter),
  `lib/scheduleShare.js` (publish/adopt), `lib/spotify.js` (artist links).
  Its window is the one `TAB_THEMES` entry with `full: true`: on desktop it
  **shrink-wraps** the grid (`width: fit-content` on `.xp-window-full`), so a
  4-stage day is half a screen, not 900px of white. That only works while the grid's
  intrinsic width is *real columns* — an expanded card in the last column flips to
  open leftward rather than buying blank grid to overhang into. Don't re-add a
  trailing pad on `.sched-stages`: `.sched-grid` is `width: max-content`, so it lands
  in the window as a blank extra stage column.

## ☠️ Gotchas that WILL waste your time

1. **Bind global listeners to `document`, never `document.body`.** `camp.js` is
   `defer`red now, so `document.body` does exist at the top level — but the rule
   stands, because a single top-level throw silently kills every listener declared
   after it, and that is exactly how this bit for a whole day when the script was
   parser-blocking. `document.body` inside functions that run later is fine.

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

9. **An htmx form must target the id its own RESPONSE carries.** The set-chat
   compose form aimed at `#set-chat-N` (a wrapper) while the handler answered with
   the inner `#set-chat-inner-N`. So the FIRST send worked and replaced the wrapper
   with a div of a different id — and every send after that resolved to no target
   and did nothing, with no error anywhere. Symptom: "I can only send one message,
   then I have to reload." Rule: for `hx-swap="outerHTML"`, target === the id the
   response's root element has, so the swap is repeatable.

10. **A partial swap leaves the state OUTSIDE it stale.** The "you're going" tint
    was a `mine` class on `.sched-tile`, but marking interest only swaps the actions
    block *inside* the tile — so the tint only appeared after a reload. Don't reach
    out and fix the ancestor from JS after the swap (ordering vs `afterSwap`/settle
    is a trap); let the ancestor read the swapped content:
    `.sched-tile:has(.sched-going)`. `:has()` matches on the DOM, not visibility, so
    it works while the card is collapsed (`display:none`). Same idea for counts —
    the card's "Chat (N)" button is re-emitted `hx-swap-oob` by the comment POST.

11. **`a:visited` (0,1,1) OUTRANKS a bare class (0,1,0).** Any `<a>` styled as a
    button must spell out `:visited` — `.sched-spotify, .sched-spotify:visited { … }`
    (and `a.xp-startmenu-name`). Otherwise the global `a:visited { color:#551a8b }`
    repaints the label the moment that link is opened. It presents as a *random*
    bug ("this one button has black text") because it only hits links **you** have
    clicked, and it can't reproduce in a fresh profile or curl.

12. **Web fonts: never strip the name table, and a changed font needs a new
    filename.** `pyftsubset --name-IDs=''` saves ~1KB and produces a font iOS
   Safari **silently rejects** — desktop Chrome tolerates it, so everything looks
   fine in every check except on the actual phone (see gotcha 4), and the color-
   emoji fallback masks the failure instead of showing tofu. Graceful fallbacks
   hide regressions: when a check is cheap (`document.fonts.check`), use it while
   verifying. `/fonts/*` is cached immutable for a week, so a rebuilt font MUST
   ship under a new filename + updated `@font-face` URL (see
   `scripts/build-unifont-emoji.sh`).

13. **`DOMContentLoaded` can fire BEFORE `retro.css` applies.** This bit when every
    `<script>` in `<head>` came *before* the stylesheet `<link>`, so nothing blocked
    on it. The head order is now stylesheet-first + `defer` on both scripts (which
    also stops 400 KB of stuff-page HTML waiting on JS), and deferred scripts do
    wait on pending stylesheets — but do not lean on that. Any load-time JS that
    **measures layout** may still be reading an unstyled page: `.sched-scroll` has
    no overflow cap yet, so
    `scrollHeight === clientHeight` and `el.scrollTop = el.scrollHeight` silently
    clamps to 0. This cost a day: the schedule opened at the headliners about half
    the time on prod (CSS usually cached) and **never** on dev (`no-cache`
    revalidates over the network every load). A "works locally, flaky in prod,
    broken on dev" bug is this shape until proven otherwise. Fixes, in order of
    preference: (a) let CSS do it — `scroll-initial-target: nearest` on a marker
    element hands the browser the job and it runs after layout, no timing to lose
    (see `.sched-start-here`); (b) if you must use JS, **verify the effect landed
    before marking it done** and retry on `window.load` (which does wait for
    stylesheets) plus a `ResizeObserver`. Never set a "done" flag on the attempt.

14. **The Luna button skin lands on EVERY `<button>`**, including ones that aren't
    meant to look like buttons. `.dog-btn` inherited `box-shadow: inset 0 0 0 1px
    #fff` and drew a white rectangle around Rover that read convincingly as a matte
    baked into `dog.webp` (the art is fine — checking the alpha proved it). Resetting
    the base rule is not enough: `button:hover` (0,1,1) **outranks** `.dog-btn`
    (0,1,0), so the ring came back the instant the pointer touched it. Spell out
    `:hover, :active, :focus` on any button you strip — same specificity trap as
    gotcha 11.

15. **A backtick inside an `html\`\`` template ends the template.** An HTML *comment*
    that quoted an identifier in backticks — inside `renderPage`'s page-long literal
    — closed it mid-page. The module then failed to parse and **every route hung with
    no error anywhere**: no stack in the response, no 500, just timeouts, which reads
    exactly like a dead dev server or the D1 lock in gotcha 8. When the whole worker
    goes unresponsive right after an edit, run `node --check <file>` on what you
    touched BEFORE investigating the server. It points at the line in a second.

16. **An htmx swap kills an in-flight CSS transition.** The replacement element
    paints at its final value, so any optimistic animation is cut off the moment the
    response lands — i.e. nearly always, and the faster the server the worse it
    looks. The animation has to be handed across the swap: record the live geometry
    on `htmx:beforeSwap`, restore it onto the replacement with `transition:none` +
    a forced reflow, then re-run the animation to the server's value
    (`campBarResume` / `campStepProgress`). Mark only the element that's actually
    animating (`data-stepping`), or the capture forces a layout read on every card
    in the list for nothing.

17. **A control that swaps its whole container must hand back every bit of state
    only the client knows.** The like button re-rendered the item card without
    `chat_open`, so liking something slammed the open comments window shut; the
    check box had the same hole. The server cannot know which `<details>` you have
    open. Enumerate them in `hx-vals` (`expanded`, `chat_open`) on *every* control
    in the card, not just the one you're adding — this bug arrived because the edit
    form already did it and the new controls didn't. And **default such a flag to
    OFF**: the pledge route defaulted `expanded` to true on the reasoning that its
    dialog could only be opened from an already-open card, which quietly stopped
    being true when the check box in the *summary* started raising it — so every
    quantity confirm sprang the card open. A missing flag should change nothing,
    not do something.

18. **Optimistic UI needs numbers only the server has — ship them as data
    attributes.** Un-ticking a pledge drops the progress bar to *everyone else's*
    total, which the DOM can't derive: it would have to know which name in the
    rendered tally is yours. So the check box carries `data-pct-on/off` and the
    dialog form carries `data-others`/`data-needed`. Compute them with the same
    rounding the server renders with (`pctOf`), so the optimistic value and the one
    arriving with the swap agree to the pixel and nothing visibly re-snaps.

19. **iOS raises the keyboard only for a `focus()` inside a real user gesture.**
    Deferring it by one `setTimeout`/`rAF`/animation callback leaves the caret
    blinking with the keyboard down. Related: `setSelectionRange()` **throws** on
    `input[type=number]`, so to park the caret at the end without selecting the
    text, round-trip the value (`v = el.value; el.value = ''; el.value = v`) — the
    value setter moves the cursor to the end, but only when the value actually
    changes, hence the trip through `''`.

20. **`toggle` (from `<details>`) does not bubble.** A document-level listener sees
    it only in the **capture** phase: `addEventListener('toggle', fn, true)`.

21. **Page weight here is DOM nodes, not bytes.** The stuff page was 645 KB of HTML
    — and 10 KB brotli'd, so transfer was never the problem; ~8100 elements on a
    phone was. The cost is identical markup repeated per card: ~70 chats × a
    15-button emoticon palette = 165 KB and ~2000 nodes for palettes nobody had
    opened, all inside *closed* `<details>`. Two fixes that worked and are worth
    copying: emit repeated STATIC markup once in a `<template>` and clone it in on
    first use (`msnToolbarTemplate` + `campFillMsnToolbars`), and don't render a
    dialog a card has no way to open (the pledge modal is rendered only when the
    check box will actually raise it). Net: −36% bytes, −42% elements, −95% images.
    Measure with `scripts/page-weight.mjs` before optimising — it ranks the blocks,
    and it's what showed transfer was already fine.
    **This includes your comments.** An `<!-- … -->` inside a per-card template is
    markup: three explanatory comments in `itemRow`/`msnLogAndCompose` shipped 72×
    each and put **72 KB** back onto the page they were describing. Explain the
    template from a `//` comment above it (or from inside a `${}`), never from an
    HTML comment inside it. Page-level markup rendered once is fine.

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
  Button order is **Cancel left, OK/default right**, and the backdrop has **no blur**
  — XP didn't blur or dim what was behind a dialog.
- **`msnToolbarTemplate()`** (`msn.js`) — the emoticon palette, emitted ONCE per page
  by `renderPage`. Chats ship an empty `.msn-toolbar`; `campFillMsnToolbars` clones
  the template in when a chat is first shown (on load, after a swap, and on the
  capture-phase `toggle`). Don't inline the palette back into `msnChat` — see
  gotcha 21.

**Popup mechanics** (`camp.js`): placement/cascade runs on `htmx:afterSwap`; a popup
stuck at the viewport top-left means that handler didn't run (see gotcha 1).
`closePopup(el)` / `popupTop()`. **Never `confirm()`/`alert()`**
— an "are you sure?" is a GET route returning an `xpDialogPopup` into `#popup-layer`
(`hx-target="#popup-layer" hx-swap="beforeend"`) whose Yes button carries the real
`hx-post` and closes itself on success. `/cars/:carId/leave-window` and
`…/checklist/:taskId/remove-window` are the two to copy. Only the `.xp-mini` "me"-tab
windows are non-draggable; popups still drag by their title bar.

**Mobile (≤600px) rules**: CSS overrides JS popup placement entirely (`left/right
12px !important`, `top: 63px !important`, full-width) — those `!important`s beat the
JS's inline style, which is the point. **Do not "fix" mobile popups to centre
vertically like desktop.** It looks wrong for a short dialog and it is genuinely
tempting, but every popup with a text field (rename, add person, chat, Spotify link)
gets the keyboard thrown up under it, and a centred window is then shoved off the top
of the screen. Pinned near the top is the only position that survives the keyboard.
The ONE exception is opt-in and narrow: `xpDialogPopup({ centerMobile: true })` for a
dialog with **no text field** (the b2b "who do you want to hear?" picker) — nothing to
type into means no keyboard to be shoved off-screen. Never set it on a form.
Body height caps use **`dvh`, never `vh`** — iOS `vh` includes the collapsed toolbar,
which pushes bottom buttons off the visible screen. Caption buttons grow to 30×27
(21px is well under Apple's 44pt touch-target guideline) — and any glyph drawn inside
one must be centred from the middle out (`left:50%` + negative margin), never by
offsets measured against the 21px desktop button, or it strands in the corner at the
bigger size. The Streets & Trips status bar drops its stop-count and coordinate cells.

## 🏗️ Server patterns

- **Page loads are latency-bound, not CPU-bound.** Every D1 statement is a network
  round trip; the render itself is free by comparison. Two rules follow:
  1. **Hand `renderPage` the body UNAWAITED** — `body: renderStuffBody(c, festival)`,
     not `body: await renderStuffBody(...)`. It fires its own chrome batch first and
     awaits `[chrome, body, pre, floating]` together, so the shell's queries overlap
     the body's. Adding an `await` back at a call site silently re-serialises them:
     the page still works, it's just a whole round trip slower, and nothing fails.
     `pre`/`floating` take promises too (see `rides.js`, `mine.js`).
  2. **Independent statements go in ONE `db.batch([...])`**, not N concurrent
     `.all()`s — one request instead of N (`loadChrome` in `layout.js`,
     `loadItemsWithStats` in `items.js`). D1 runs a batch's statements in series,
     which is the right trade only while the queries are small; if one ever grows
     expensive, split it back out. A batch fails as a UNIT, so wrap it in a
     try/catch that degrades to safe defaults instead of per-statement `.catch()`.
  Prefer answering a question in SQL over fetching rows to sift in JS —
  `passStatement` is three `EXISTS` in one row where two queries used to be.
- **Tab switches are htmx swaps of `#desktop`, not page loads.** `renderPage` builds
  `desktopInner` — icon row, `pre` window, main window, `#mine-floating` — and serves
  it two ways: wrapped in `<div id="desktop">` for a full page, or bare (plus a
  `<title>` and Rover as `hx-swap-oob`) when the request carries **`HX-Target:
  desktop`**. Routes call `renderPage` exactly as before; none of them know.
  Three rules follow, and breaking any of them is silent:
  1. **Anything that must SURVIVE a tab switch lives outside `#desktop`** — taskbar,
     the three overlay layers, `#dog-slot`. Put a thing inside and it is destroyed
     and rebuilt on every tab click. The tray icons visibly popped in on every switch
     for exactly this reason, back when the whole document was torn down.
  2. **Detect on `HX-Target`, never a bare `HX-Request`.** Other htmx requests hit
     these same URLs aiming at `#main`, `#car-list`, … and must get their own markup.
     And `HX-History-Restore-Request` must fall through to the **full page**: htmx
     replaces the entire `<body>` with that response, so a fragment would delete the
     taskbar.
  3. **`hx-target`/`hx-swap`/`hx-push-url` are inherited** from the `<nav>` by every
     `<a>` inside it. A link that targets something else (the signed-out Log In icon)
     must override `hx-push-url` **as well as** `hx-target`, or it pushes a URL that
     was never navigated to. Inheritance is per-attribute.
  4. **It is `hx-boost`, and must stay `hx-boost`** — not an `hx-get` per link. This
     looks like a style choice and is not. htmx's click handler runs
     `if (ft) return;` (boosted anchor + ctrl/meta → let the browser have it) *before*
     `if (ut) preventDefault()`, and `ft` tests the **boosted** flag specifically. Swap
     in `hx-get` and cmd/ctrl-click gets eaten: no new tab and no swap. A
     `click[!metaKey]` trigger filter does not rescue it either — filters are evaluated
     after `preventDefault`. Boost also reads the link's own `href`, so `href` stays the
     single source of truth for where an icon points.
  `historyCacheSize` is **0** on purpose (`<meta name="htmx-config">`): htmx snapshots
  the whole body into localStorage per push, the stuff page is ~390 KB raw, and the
  default of 10 would thrash a ~5 MB quota with megabytes of JSON on every click.
  Back/Forward therefore re-requests — which rule 2 already answers correctly.
  Anything reached this way must re-init on `htmx:afterSwap`, because `DOMContentLoaded`
  and `load` fire once per DOCUMENT and never again (that's why
  `campInitScheduleScroll` is on both).
- **htmx cannot do optimistic UI.** It paints only what the server sends, so a
  tapped control sits visibly still for a whole round trip (very obvious on a
  phone). For counters/toggles, flip the element's own state in an `onclick` and
  let the swap land on top with the authoritative value — `campVoteOptimistic` is
  the pattern. Keep it dumb: no request tracking, no rollback. The swap always
  wins, so a failed request is briefly off by one and self-corrects.
- **Preferences: per-DEVICE → localStorage, per-PERSON → a column on `people`.**
  Clock format, confetti and pixel emoji are device prefs (`campSetTimeFmt` /
  `campSetConfetti` / `campSetPixmoji`, reflected into the Control Panel by
  `campInitSettings` because the server can't render them). Anything that must
  follow you between phone and laptop goes on the person row (`email`,
  `email_unsubscribed`), because **a column on `people` is free to read**: the
  session middleware already SELECTs the whole row on every request, so the page
  pays nothing, where a `preferences` table would add a query to every render.
  Write it with a bare UPDATE and then **mutate `c.get('person')` in place** before
  re-rendering (`/settings/email` does this) — re-reading the row is a wasted round
  trip. Before adding either kind, though, ask whether the setting should exist:
  What I'm Bringing shipped with a "Packing Mode" switch (and a `people.packing_mode`
  column) for all of an afternoon before it was obvious the mode wanted to be the
  only mode. A pref you can't imagine anyone turning off is a pref you don't need.
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
  the `logAction` entirely (no audit spam, no Log noise) — see `POST /f/:id/meet`.
- **Ghost people** (`src/lib/people.js`): `is_placeholder=1`, synthetic unique
  `normalized_name`, `placeholder_key` = normalized display name; absorbed into the
  real account on first login. **Person delete = soft-hide manifest**
  (`deletePersonFootprint`) — never hard-DELETE people (FKs everywhere, and undo
  restores the whole footprint from the manifest).
- **Sign-in is a pick list, not just a text box** (`nameField` in `guard.js`): the
  fest's roster ships embedded in `data-names` and is filtered locally by
  `campSigninMatches` in camp.js — no fetch, so the list is up on the first keystroke
  (and only from the first: an empty box offers nothing, or it drops open over the
  form on autofocus). This is a correctness feature, not a nicety: `normalized_name`
  IS the credential, so a typo doesn't fail loudly, it silently opens a SECOND
  account that then needs a hand-merge. **Nothing warns you off an existing name** —
  picking one is the intended path, and the old live `/signin/check-name` notice plus
  the "Name Already in Use / Yes, That's Me" window (and `/signin/reclaim` behind it)
  are gone. An existing name signs you in as them, trust-based, exactly as the no-JS
  path always did. Signed out, the About Me desktop icon renders as **Log In**
  (`desktopIcons`) with `next` back to `/mine`, so logging on lands where they were
  headed.
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
  `xpDialogPopup`. Three modes on the ppl tab (rename=1, merge=2, delete=n — the cap
  is `campSelectCap`) plus the car roster. Copy, don't invent.
- **Renaming a person touches their IDENTITY, not just a label.** For a real account
  `normalized_name` IS the sign-in credential and the invariant is
  `normalized_name === normalizeName(display_name)` (set at signup) — rename both or
  the next sign-in under the new name silently creates a SECOND account. For a ghost
  the synthetic `normalized_name` is meaningless; update `placeholder_key` instead,
  or they'll never get absorbed. `normalized_name` is UNIQUE, so check for a clash
  first and offer **Merge** — an uncaught clash is a 500.
- **A poster name is not an artist name** (`splitArtists` in `lib/spotify.js`).
  Measured against the real API, not assumed: `DJ DIESEL AKA SHAQ` searches to
  "DIESEL" (a different act) so the alias must be stripped; `SULLIVAN KING b2b KAYZO`
  returns whichever member Spotify ranks first, so a b2b **asks** which one via an
  `xpDialogPopup`; a trailing `(SUNSET SET)` is a slot note, not a name. But
  `RIVA + BIANCA` is an EXACT match — a real duo with its own page — so **`+` is
  deliberately not a separator**. Splitting it "for symmetry" would break a name that
  already works. When in doubt, probe the API (`scripts/probe-artist-names.mjs`)
  rather than reason from the shape of the string.
- **Spotify Web API, apps created after Nov 2024**: editorial/algorithmic playlists
  ("This Is X") come back as `null` in search, `popularity`/`followers` are stripped
  from search results, and `GET /v1/artists` is a flat 403. Search ORDER is the only
  popularity signal you get — so "most popular" means "ranked first", with an exact
  normalized-name match preferred over it.
- **Poster vision parse** (`lib/scheduleParse.js`): strict `json_schema` structured
  output, with a freeform retry for providers that reject `response_format` — the
  prompt therefore has to carry a literal JSON example for that fallback path.
  Extended thinking is on (`reasoning: { effort: 'medium' }`), which means **no
  `temperature`** (Anthropic only accepts 1 with thinking) and `max_tokens` must
  cover reasoning + answer from one pot. Measured: thinking composes fine with the
  schema but changed nothing on our sample (37 sets either way, ~80-150 reasoning
  tokens) — it's insurance for a messier poster, not a fix for a known miss.
- **Personalize where cheap**: the Streets & Trips "1: Depart from …" leg reads the
  viewer's own car's `leaving_from` (`viewerDepartFrom`), falling back to "home".
- **The map pane is a cross-origin iframe** (openstreetmap.org `export/embed.html`),
  so nothing inside it can be scripted or styled from our page — including its own
  +/− buttons, one of which doesn't zoom back out. The zoom control you see is OURS
  (`.st-zoom` / `campMapZoom`), and it works the only way available: rewriting the
  `bbox` in the embed URL around its own centre and reloading the frame. Don't try to
  reach into the frame; don't assume a map bug is ours.

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
- **Secrets**: the prod name must be **byte-identical to what the code reads** —
  that's the whole rule. (Most are `*_API_KEY`, but that's a naming habit, not the
  rule: `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` aren't.) `wrangler secret put`,
  local in `.dev.vars`, gitignored. A mismatch is **silent** — the code sees
  `!env.FOO` and takes the graceful path forever (misnamed `OPENROUTER` → every item
  got the 📦 fallback and OpenRouter logs showed nothing from prod). After adding
  one, `wrangler secret list` and eyeball the spelling against the source.
  Google key: GCP project `southern-sol-496313-g7`, key `camp-planner-places`,
  restricted to Places API (New).
- Prod route: **`camp.cuuush.com/*`** (zone `cuuush.com`).
- **`git fetch` BEFORE any manual `wrangler deploy`.** Deploy ships your working
  tree, not `origin/main` — so a manual deploy from a stale checkout silently rolls
  production BACKWARDS to whatever you last pulled. This happened: a deploy from a
  local branch missing 8 upstream commits un-shipped the e-mail HTML-injection
  escaping, HMAC unsubscribe tokens, `Secure` session cookies and the `/admin`
  sign-in gate — prod ran unprotected until the merge landed. The normal path is to
  **push and let CI deploy** (`.github/workflows/deploy.yml`: baseline → migrate →
  deploy). If you must deploy by hand, `git fetch && git status` first and confirm
  you are not behind.

## 🗣️ Copy voice: authentic Windows XP — NO EXCEPTIONS

Write **every** user-visible string as if it ships inside the OS: button labels,
titles, confirms, hints, placeholders, empty states, errors, notifications, log
summaries. Ask "would this exact wording have shipped in Windows XP?" — rewrite
until yes.

- **Title Case buttons**: "OK", "Cancel", "Post Car". A trailing `…` on a button
  that opens a dialog is authentic ("Add…", "Browse…"); a leading ＋/emoji is not.
- **Confirms**: "Are you sure you want to…". **Progress**: "Please wait while…".
  **Empty states**: "There are no X in this view." **Spelling**: "e-mail".
- **No em dashes in NEW user-visible copy**, not just in Rover's balloon. An em dash
  is a 2026 tell and Chris spots every one. Split the sentence or use a comma. Note
  the existing copy is not clean: roughly thirty shipped strings still have one
  (`grep '—' src/routes/*.js`). Don't add to the pile; sweeping the rest is its own
  job. (Code comments in this repo are full of them, and that's fine. This is a rule
  about shipped strings.)
- **Labels** end with a colon ("Search for:", "Place:"). **Dialog headers** ask the
  Search Companion question ("Where is everyone meeting up?") then explain.
- **Placeholders are SAMPLE VALUES**, never instructions: `Redmond, WA`,
  `9:00 AM`, `Thu`, `Type their name`. No meta-hints like "blank = idk".
- **Rover is a NOTIFICATION, not a mascot** (`dogAssistant`): he renders only when
  something is undone (not signed in; passes unbought; schedule posted but nothing
  starred). The rotating tip pool is gone — no "did you know" chatter. An EMPTY
  schedule deliberately gets no nag: importing a poster is too big an ask.
- **His copy is a balloon tip, not a help article**: short question/greeting as the
  title, ONE short line of body, action as the link. "You haven't picked any sets
  yet." — not "I noticed you haven't picked any sets yet. Would you like me to
  help? Just open the Schedule and click…". The link IS the button, so never spell
  out which control to click. First person, cheery, no em dashes. Wordiness creeps
  back one helpful clause at a time; cut it.
- Fun stays fun (tab names, Rover, BSOD) — but frame jokes in XP phrasing, never
  lowercase internet-casual.

## 🔤 Pixmoji: how emoji get pixelated (and how to debug when they don't)

Client JS (`pixmojify` in camp.js) wraps emoji text in `.pixmoji` spans; CSS gives
those a pixel-font stack: **UnifontExMono** (jsDelivr, covers emoji ≤ Unicode 11)
→ **UnifontEmoji16** (self-hosted `/fonts/unifont-emoji16a.woff2`, plane-1 subset
of GNU Unifont 16, fills every 2019+ emoji — mirror, wood, coin…) → system.
`window.PIXMOJI_RANGES` (from `src/render/pixmoji-coverage.js`, generated by
`scripts/gen-pixmoji-coverage.mjs`) gates wrapping so uncovered emoji stay native
instead of tofu. **It is OPT-IN**: Control Panel → Appearance → "Use pixelated
emoticons", a per-device localStorage pref (`campPixmojiOn`). Off is the default and
means `pixmojify` returns immediately — no tree walk, no spans, and the two Unifont
faces are never used so the browser never downloads them. Un-ticking mid-session
can't un-wrap what's already in the DOM, so it kills the pixel font from a
`.no-pixmoji` class on `<html>` instead. **"Emoji X isn't pixelated" checklist**:
(0) is the option even on? (1) is it inside a `.pixmoji` span? if not →
regex/coverage/`pixmojify` didn't run; (2) which font
owns that codepoint (new emoji = the gap-filler); (3) did that font load —
`document.fonts.check('16px UnifontEmoji16', '🪞')`; (4) **check on the phone** —
Safari rejects fonts Chrome accepts (gotcha 9), and the color fallback hides it.

Code comments explain *why*. Soft-delete everywhere; everything audited and undoable.
