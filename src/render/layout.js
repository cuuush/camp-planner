import { html, raw } from 'hono/html';
import { PIXMOJI_COVERED_RANGES } from './pixmoji-coverage.js';
import { xpCaptionBtns } from './popup.js';

// The scrolling news marquee that used to sit at the top of every window body is
// gone (along with tickerHtml() and its `SELECT … FROM audit_log ORDER BY
// created_at DESC LIMIT 15` on every fest page). It cost a query per page load
// and an animation that never stopped compositing. The Log tab still has the
// same content, on purpose, and reads better sitting still.

// Everything the page shell needs from the database, in ONE round trip. These
// lookups are tiny and independent, so they go out as a single db.batch() rather
// than 3 concurrent statements: same data, one request instead of three.
function passStatement(db, festivalId, personId) {
    // Rover's nag, answered by the database instead of by JS over a result set:
    // "is this person a driver (so do they owe a car pass), and which of the two
    // default passes have they already checked off?" Three EXISTS in one row —
    // it replaces a cars lookup plus a fetch-every-checked-label query that then
    // filtered the labels client-side.
    // ?1 = festival, ?2 = person, so the two ids bind once each however many
    // subqueries reference them.
    return db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM cars
                 WHERE festival_id = ?1 AND driver_person_id = ?2 AND deleted_at IS NULL) AS driving,
          EXISTS(SELECT 1 FROM checklist_tasks t
                 JOIN checklist_checks cc ON cc.task_id = t.id
                 WHERE t.festival_id = ?1 AND t.is_default = 1 AND t.deleted_at IS NULL
                   AND cc.person_id = ?2 AND cc.unchecked_at IS NULL
                   AND lower(t.label) = 'festival pass') AS got_fest_pass,
          EXISTS(SELECT 1 FROM checklist_tasks t
                 JOIN checklist_checks cc ON cc.task_id = t.id
                 WHERE t.festival_id = ?1 AND t.is_default = 1 AND t.deleted_at IS NULL
                   AND cc.person_id = ?2 AND cc.unchecked_at IS NULL
                   AND lower(t.label) = 'car pass') AS got_car_pass,
          -- Fest-level, not person-level: has anyone put a schedule in at all?
          EXISTS(SELECT 1 FROM schedule_sets
                 WHERE festival_id = ?1 AND deleted_at IS NULL) AS has_schedule,
          -- ...and has THIS person starred anything on it?
          EXISTS(SELECT 1 FROM set_interests si
                 JOIN schedule_sets ss ON ss.id = si.set_id
                 WHERE ss.festival_id = ?1 AND si.person_id = ?2 AND si.deleted_at IS NULL) AS mine
    `).bind(festivalId, personId);
}

async function loadChrome(db, festival, person) {
    // The membership + pass lookups only mean anything for a signed-in person on
    // a fest page; off that path the batch is a single statement.
    const personal = !!(festival && person);
    const stmts = [db.prepare('SELECT id, name FROM festivals WHERE deleted_at IS NULL ORDER BY name')];
    if (personal) {
        stmts.push(db.prepare('SELECT 1 AS ok FROM memberships WHERE festival_id = ? AND person_id = ? AND bailed_at IS NULL')
            .bind(festival.id, person.id));
        stmts.push(passStatement(db, festival.id, person.id));
    }
    try {
        const res = await db.batch(stmts);
        return {
            festivals: res[0].results,
            // On lookup failure pretend they're a member so we don't flash the
            // join banner at someone who is already on the list.
            isMember: personal ? res[1].results.length > 0 : true,
            passes: personal ? res[2].results[0] : null,
        };
    } catch {
        // A batch fails as a unit, so one bad statement costs all three. Degrade
        // to a shell that's still usable: no fest list in the Start menu, no join
        // banner, no Rover — same "quietly do less" the per-query .catch()es did.
        return { festivals: [], isMember: true, passes: null };
    }
}

// Rover the XP Search Companion, docked bottom-right. He is a NOTIFICATION, not a
// mascot: he only turns up when there is something you haven't done — sign in, or
// buy the passes you still owe — and the page renders without him otherwise. (He
// used to sit above the content cycling XP-help tips like "Your opinion counts!";
// they pushed the actual page below the fold to say nothing, so they're gone.)
// Copy stays in cheery early-2000s Windows-helper voice. The balloon is collapsed
// until you click him (public/camp.js), so he costs one dog's worth of screen.
// Pure rendering now — `passes` is the row loadChrome() already fetched, so
// deciding whether to show him costs no queries of its own.
function dogAssistant(c, festival, person, passes) {
    let bubble;
    if (!person) {
        // Only nudge on a festival page, where signing in has an obvious point (and
        // also joins you). On the main fest-selection page (root) Rover stays quiet.
        if (!festival) return '';
        // Bring them back to exactly where they are (and, if it's a fest page,
        // sign-in also joins them). Pop the modal in place rather than navigating.
        const next = encodeURIComponent(c.req.path);
        bubble = html`
          <span class="dog-title">Hi there, I'm Rover!</span>
          It looks like you're just visiting. Sign in and I'll help you claim what you're bringing and save you a seat in a carpool.
          <ul class="dog-links">
            <li><a href="/signin?next=${next}" hx-get="/signin/modal?next=${next}" hx-target="#signin-modal-overlay" hx-swap="innerHTML">Sign in &amp; join this fest</a></li>
          </ul>`;
    } else if (festival) {
        // No row means the chrome batch failed — say nothing rather than guess.
        if (!passes) return '';
        const needFestPass = !passes.got_fest_pass;
        // Only drivers owe a car pass, so only nag drivers about it.
        const needCarPass = !!passes.driving && !passes.got_car_pass;
        // Fest has set times posted, but this person hasn't starred a single act.
        const needSchedulePick = !!passes.has_schedule && !passes.mine;

        if (needFestPass || needCarPass) {
            // All THREE combinations, not two. The copy used to branch only on
            // needCarPass, so a driver who'd bought their festival pass but not
            // their car pass was still told to pick up "your festival pass and
            // car pass" — nagged about something already ticked off their list.
            const both = needFestPass && needCarPass;
            const owed = both
                ? html`your <b>festival pass</b> and <b>car pass</b>`
                : needFestPass
                    ? html`your <b>festival pass</b>`
                    : html`your <b>car pass</b>`;
            const it = both ? 'them' : 'it';
            bubble = html`
              <span class="dog-title">Hey ${person.display_name}!</span>
              Have you picked up ${owed} yet? Once you've got ${it}, just check ${it} off your list.
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/mine">Go to my checklist</a></li>
              </ul>`;
        } else if (!passes.has_schedule) {
            // Nobody has put the set times in at all yet — the one feature that
            // stays useless until someone seeds it. Sits below the pass nags so
            // Rover never stacks two things to do.
            bubble = html`
              <span class="dog-title">Shall we add the set times?</span>
              Hi there, ${person.display_name}! Nobody has put the lineup for <b>${festival.name}</b> in yet, so the Schedule is empty. Would you like me to help? Open the <b>Schedule</b>, click <b>Edit Schedule</b>, and then click <b>Import</b>. You can point me straight at a photo of the lineup poster and I'll read it for you!
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/schedule">Open the Schedule</a></li>
              </ul>`;
        } else if (needSchedulePick) {
            // Set times are up but this person hasn't starred anyone. Full XP Search
            // Companion routine: Rover greets them, notices the gap, and OFFERS to help
            // ("Would you like me to help?"), the way the real Search Companion always
            // framed a task. Cheery, first person, no em dashes, no guilt.
            bubble = html`
              <span class="dog-title">Who do you want to see?</span>
              Hi there, ${person.display_name}! I noticed you haven't picked any sets yet. Would you like me to help? Just open the <b>Schedule</b> and click <b>I'm Interested</b> next to each artist you'd like to catch. I'll keep your whole lineup safe, and your friends will know right where to find you!
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/schedule">Open the Schedule</a></li>
              </ul>`;
        } else {
            // Nothing outstanding at all. No idle tips: Rover is a notification.
            return '';
        }
    } else {
        // Signed in but not on a fest page (the festival list, settings, …) —
        // nothing is outstanding here, so Rover stays in his kennel.
        return '';
    }
    // Collapsed by default: the dog hops in place until you click him, then the
    // balloon pops out above his head. `aria-expanded` on the button is the real
    // state; camp.js keeps it in sync with the .open class.
    return html`
    <div class="dog-assistant" id="dog-assistant">
      <div class="dog-bubble" id="dog-bubble" role="status">${bubble}</div>
      <button type="button" class="dog-btn" aria-expanded="false" aria-controls="dog-bubble"
        title="Rover has something to tell you">
        <img class="dog-img" src="/dog.webp" alt="Rover the assistant dog">
      </button>
    </div>`;
}

// Rover lives OUTSIDE #main, so a partial swap of the page body leaves him
// exactly as he was — check off your festival pass and the nag stayed up until a
// reload (AGENTS.md gotcha 10). The fix is the repo's usual one: he sits in a slot
// that is ALWAYS in the DOM, empty or not, and any mutation that can change what
// he'd say re-emits the slot `hx-swap-oob`. It has to be a wrapper rather than the
// dog himself — an OOB swap needs a target id to still be there, and "no dog" has
// no element to carry one.
export function dogSlot(inner) {
    return html`<div id="dog-slot">${inner}</div>`;
}

// The same slot, as an out-of-band swap to staple onto a fragment response. Costs
// one extra statement on the mutation; the alternative is a stale nag.
export async function dogSlotOob(c, festival) {
    const person = c.get('person');
    let passes = null;
    if (festival && person) {
        passes = await passStatement(c.env.DB, festival.id, person.id).first().catch(() => null);
    }
    return html`<div id="dog-slot" hx-swap-oob="outerHTML">${dogAssistant(c, festival, person, passes)}</div>`;
}

// The XP taskbar + fake Start menu. The green Start button toggles a Start menu
// holding: the signed-in account (blue header band), the festival list to jump
// between, create-a-fest, and Log Off in the blue footer band. Clicking outside
// or pressing Escape closes it (wired in public/camp.js).
function taskbar(c, festival, festivals) {
    const person = c.get('person');
    const next = encodeURIComponent(c.req.path);
    return html`
    <div class="xp-taskbar">
      <button type="button" class="xp-start-btn" onclick="campToggleStart(event)"
        aria-haspopup="true" aria-controls="xp-startmenu" title="start">
        <img src="/start.png" alt="start">
      </button>
      <span class="xp-tray">
        <img class="xp-tray-ico" src="/xp/tray-shield.png" alt="Security Center" title="Security Center: your computer is protected">
        <img class="xp-tray-ico" src="/xp/tray-media.png" alt="Media" title="Windows Media Connect">
        <img class="xp-tray-ico" src="/xp/tray-volume.png" alt="Volume" title="Volume">
        <span id="xp-clock"></span>
      </span>
      <div class="xp-startmenu" id="xp-startmenu" hidden>
        <div class="xp-startmenu-head">
          <span class="xp-user-pic"><img src="/spaceman.png" alt=""></span>
          ${person
            ? html`<span class="xp-startmenu-name">${person.display_name}</span>`
            : html`<a class="xp-startmenu-name" href="/signin?next=${next}" onclick="campCloseStart()"
                     hx-get="/signin/modal?next=${next}" hx-target="#signin-modal-overlay" hx-swap="innerHTML">Sign in…</a>`}
        </div>
        <div class="xp-startmenu-body">
          <div class="xp-startmenu-label">festivals</div>
          ${(festivals || []).map((f) => html`
            <a class="xp-startmenu-item ${festival && f.id === festival.id ? 'current' : ''}" href="/f/${f.id}">
              <img class="xp-startmenu-ico" src="/xp/folder.png" alt=""> ${f.name}</a>`)}
          <div class="xp-startmenu-sep"></div>
          <a class="xp-startmenu-item" href="/"><img class="xp-startmenu-ico" src="/xp/my-computer.png" alt=""> My Festivals</a>
          <a class="xp-startmenu-item" href="/fests/new"><img class="xp-startmenu-ico" src="/xp/new-folder.png" alt=""> New Festival…</a>
          <div class="xp-startmenu-sep"></div>
          <a class="xp-startmenu-item" href="/feedback" onclick="campCloseStart()"
            hx-get="/feedback/window" hx-target="#popup-layer" hx-swap="beforeend">
            <img class="xp-startmenu-ico" src="/xp/feedback.png" alt=""> Send Feedback</a>
          <a class="xp-startmenu-item" href="/settings" onclick="campCloseStart()"
            hx-get="/settings/window" hx-target="#popup-layer" hx-swap="beforeend">
            <img class="xp-startmenu-ico" src="/xp/control-panel.png" alt=""> Control Panel</a>
          <a class="xp-startmenu-item" href="/admin" onclick="campCloseStart()">
            <img class="xp-startmenu-ico" src="/xp/admin.png" alt=""> Administrative Tools</a>
          ${festival ? html`
          <a class="xp-startmenu-item" href="/f/${festival.id}/log" onclick="campCloseStart()">
            <img class="xp-startmenu-ico" src="/xp/desk-log.png" alt=""> Event Viewer (Log)</a>` : ''}
        </div>
        <div class="xp-startmenu-foot">
          ${person
            ? html`<a class="xp-logoff" href="/signout"><img class="xp-logoff-ico" src="/xp/logoff.png" alt=""> Log Off</a>`
            : html`<a class="xp-logoff" href="/signin?next=${next}" onclick="campCloseStart()"
                     hx-get="/signin/modal?next=${next}" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
                     <img class="xp-logoff-ico" src="/xp/logon.png" alt=""> Log On</a>`}
        </div>
      </div>
    </div>`;
}

// Each section is a pretend XP program: a desktop icon on the wallpaper (the old
// text tabs), and its own themed window chrome — titlebar icon, window title, and
// a decorative menu bar — in the spirit of the Streets & Trips meeting-spot
// window. `address` adds an Explorer-style address bar (Stuff only). The key is
// the activeTab name the routes already pass; `path` is the URL segment.
const TAB_THEMES = {
    stuff: {
        label: 'Stuff', path: 'stuff', ico: '/xp/desk-stuff.png',
        // "Shared Documents", but for camping. Short on purpose: the old
        // "What we are bringing to <fest>" wrapped the titlebar on phones —
        // the fest name still shows in the address bar right below.
        title: () => 'Shared Stuff',
        menus: ['File', 'Edit', 'View', 'Favorites', 'Tools', 'Help'],
        address: (f) => `C:\\Camp Planner\\${f.name}\\Stuff`,
    },
    ppl: {
        label: 'People', path: 'ppl', ico: '/xp/desk-people.png',
        title: (f) => `Address Book - ${f.name}`,
        menus: ['File', 'Edit', 'View', 'Tools', 'Help'],
    },
    rides: {
        label: 'Cars', path: 'rides', ico: '/xp/desk-cars.png', titleEmoji: '🚗',
        title: (f) => `Car Pool - ${f.name}`,
        menus: ['File', 'Edit', 'View', 'Route', 'Tools', 'Help'],
    },
    schedule: {
        label: 'Schedule', path: 'schedule', ico: '/xp/desk-schedule.png',
        title: (f) => `Set Times - ${f.name}`,
        menus: ['File', 'View', 'Play', 'Tools', 'Help'],
        // The set-times grid is a wide, side-scrolling poster, so this window drops
        // the usual gutters and runs the full width of the screen — on a phone those
        // gutters cost enough room to push the time ruler out of view.
        full: true,
    },
    mine: {
        label: 'About Me', path: 'mine', ico: '/xp/desk-me.png',
        title: (f) => `About Me - ${f.name}`,
        menus: ['File', 'Edit', 'View', 'Help'],
    },
    // The Log moved off the desktop tab row into the Start menu (it's a system
    // utility now, like Event Viewer really is). `hidden` keeps its Event Viewer
    // window chrome — titlebar icon, menu bar — for the /f/:id/log page while
    // desktopIcons() skips it in the tab row.
    log: {
        label: 'Log', path: 'log', ico: '/xp/desk-log.png', hidden: true,
        title: (f) => `Event Viewer - ${f.name}`,
        menus: ['File', 'Action', 'View', 'Help'],
    },
};

// The tab row, redrawn as a centered row of XP desktop icons sitting directly on
// the wallpaper (labels in white Tahoma with the desktop's soft drop shadow). The
// current section renders "selected": label highlighted in Luna blue and the icon
// tinted, exactly like a clicked desktop icon. --ico feeds the CSS mask that
// paints the selection tint over just the icon's own pixels.
function desktopIcons(festival, activeTab) {
    return html`
    <nav class="desktop-icons" aria-label="sections">
      ${Object.entries(TAB_THEMES).filter(([, t]) => !t.hidden).map(([key, t]) => html`
        <a href="/f/${festival.id}/${t.path}" class="desk-icon ${key === activeTab ? 'active' : ''}"
          style="--ico:url('${t.ico}')" ${key === activeTab ? html`aria-current="page"` : ''}>
          <span class="desk-icon-img"><img src="${t.ico}" alt=""></span>
          <span class="desk-icon-label">${t.label}</span>
        </a>`)}
    </nav>`;
}

// `pre` renders between the desktop icons and the main window — for pages that
// bring their own sibling window (the cars tab docks Streets & Trips there), so
// windows sit next to each other on the desktop instead of nesting.
// `bare` drops the main window entirely (About Me: everything lives in the
// floating mini windows, so the main window is an empty shell). #main survives
// as an invisible element because it's the hx-target of every mine-tab form.
// A join banner still forces the window — it needs somewhere to live.
// `body`, `pre` and `floating` may be PROMISES — pass them unawaited. The shell's
// own lookups don't depend on the body's, so this fires the chrome batch first and
// lets the body's queries run alongside it. Handlers used to `await` the body and
// then call this, which put the two sets of queries in series and cost a whole
// extra round trip of latency on every single page load.
export async function renderPage(c, { title, activeTab = '', body, festival = null, floating = '', pre = '', bare = false, windowTitle = null }) {
    const db = c.env.DB;
    const person = c.get('person');

    // Kick the shell's one batched round trip off BEFORE awaiting anything.
    const chromeReq = loadChrome(db, festival, person);
    const [chrome, bodyHtml, preHtml, floatingHtml] = await Promise.all([chromeReq, body, pre, floating]);
    const { festivals, isMember, passes } = chrome;

    // Signed-in-but-not-a-member of the fest you're looking at → offer to join.
    const showJoin = !isMember;
    const dogHtml = dogAssistant(c, festival, person, passes);

    const theme = (festival && TAB_THEMES[activeTab]) || null;
    // windowTitle lets themeless pages (admin, unsubscribe…) name their own
    // window instead of getting the generic fallback.
    const winTitle = windowTitle || (theme ? theme.title(festival) : `${festival ? festival.name : 'camp planner'} — Camp Planner`);

    return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- viewport-fit=cover is what lets the Bliss wallpaper reach the very edges of
       an iPhone screen. WITHOUT it iOS insets the whole layout viewport inside the
       safe area and paints the leftover strips — behind the status bar / Dynamic
       Island, and down by the home indicator — with the canvas colour. No element
       can paint there at any size, which is why the wallpaper layer's 120px
       overhang (retro.css) never covered them: it wasn't too small, it was out of
       bounds. With cover, the viewport is edge-to-edge and the fixed wallpaper
       layer fills those strips. Anything that must stay clear of the notch then
       has to say so itself via env(safe-area-inset-*) — see .xp-taskbar.
       Deliberately NO <meta name="theme-color">: setting it repaints the status
       bar strip a flat colour, which is exactly the band we're getting rid of. -->
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${title} :: camp planner</title>
  <!-- Self-hosted (was unpkg): first paint shouldn't wait on a third-party CDN's
       DNS + TLS + fetch. Version in the filename + immutable cache (public/_headers);
       bump the name when upgrading htmx. -->
  <script src="/htmx-1.9.12.min.js"></script>
  <script>window.PIXMOJI_RANGES=${raw(JSON.stringify(PIXMOJI_COVERED_RANGES))};</script>
  <!-- No defer: camp.js binds its listeners to document at top level and must
       run before the body parses, same as when it was an inline script.
       Freshness comes from Cache-Control: no-cache + ETag (public/_headers):
       the browser revalidates each load and gets a 304 unless the file changed. -->
  <script src="/camp.js"></script>
  <link rel="stylesheet" href="/retro.css">
</head>
<body>
  ${taskbar(c, festival, festivals)}
  <div class="title-gap" aria-hidden="true"></div>
  <!-- Icons first: they're the way into everything, so they sit directly under
       the taskbar with the program window right below. Rover is position:fixed
       bottom-right and renders last so he's out of the flow entirely. -->
  ${festival ? desktopIcons(festival, activeTab) : ''}
  <div id="signin-modal-overlay"></div>
  <div id="popup-layer"></div>
  <div id="toast"></div>
  ${preHtml}
  ${bare && !showJoin ? html`<main id="main" hidden>${bodyHtml}</main>` : html`
  <div class="xp-window ${theme && theme.full ? 'xp-window-full' : ''}">
    <div class="xp-titlebar">
      ${theme
        ? (theme.titleEmoji
            ? html`<span class="xp-titlebar-icon">${theme.titleEmoji}</span>`
            : html`<img class="xp-titlebar-ico" src="${theme.ico}" alt="">`)
        : ''}
      <span class="xp-titlebar-text">${winTitle}</span>
      ${xpCaptionBtns()}
    </div>
    ${theme ? html`<div class="xp-menubar" aria-hidden="true">${theme.menus.map((m) => html`<span class="xp-menu">${m}</span>`)}</div>` : ''}
    ${theme && theme.address ? html`
    <div class="xp-addressbar" aria-hidden="true">
      <span class="xp-address-label">Address</span>
      <span class="xp-address-field"><img src="/xp/folder.png" alt="">${theme.address(festival)}</span>
    </div>` : ''}
    <div class="xp-window-body">
      ${showJoin ? html`
        <div class="join-banner">
          <span class="join-banner-text">You are browsing <b>${festival.name}</b> as a guest — you are not on the list yet.</span>
          <form method="post" action="/f/${festival.id}/join" class="join-banner-form">
            <button class="btn btn-primary" type="submit">✔ i'm going!</button>
          </form>
        </div>` : ''}
      <main id="main">
        ${bodyHtml}
      </main>
    </div>
  </div>`}
  <div id="mine-floating" class="mine-floating">${floatingHtml}</div>
  ${dogSlot(dogHtml)}
  <div class="site-foot-space" aria-hidden="true"></div>
</body>
</html>`;
}
