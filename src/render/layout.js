import { html, raw } from 'hono/html';
import { PIXMOJI_COVERED_RANGES } from './pixmoji-coverage.js';
import { xpCaptionBtns } from './popup.js';
import { msnToolbarTemplate } from './msn.js';

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
// His links carry DESKTOP_HX themselves. The desktop icons inherit those attributes
// from their <nav>, but Rover lives outside it (and outside #desktop), so without
// them his links are ordinary navigations that tear the document down — and the OOB
// #dog-slot swap that sends him hopping off never happens. Following "Open the
// Schedule" has to look exactly like clicking the Schedule icon, because it is.
// Copy is shaped like a real XP balloon tip, NOT like a help article: a short
// question or greeting as the title, ONE short line of body, and the action as a
// link below. No "would you like me to help?", no explaining which button to press
// — the link is the button. ("There are unused icons on your desktop", not three
// sentences about it.) The balloon is collapsed until you click him
// (public/camp.js), so he costs one dog's worth of screen.
// Pure rendering now — `passes` is the row loadChrome() already fetched, so
// deciding whether to show him costs no queries of its own.
function dogAssistant(c, festival, person, passes) {
    let bubble;
    let nag = '';
    // A stable id for WHICH nag this is, independent of `nag` above (that one only
    // exists for the schedule case, and means something else — see campDogNag in
    // camp.js). "Go away" dismissal is per-device (localStorage, like the clock and
    // confetti prefs) and keyed on this, so blowing off "buy your pass" doesn't also
    // silence an unrelated "pick your sets" nag that shows up later.
    let key = '';
    if (!person) {
        // Only nudge on a festival page, where signing in has an obvious point (and
        // also joins you). On the main fest-selection page (root) Rover stays quiet.
        if (!festival) return '';
        // Bring them back to exactly where they are (and, if it's a fest page,
        // sign-in also joins them). Pop the modal in place rather than navigating.
        const next = encodeURIComponent(c.req.path);
        key = 'signin';
        bubble = html`
          <span class="dog-title">Hi there, I'm Rover!</span>
          You're just visiting. Sign in and I'll save your spot.
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
        // The has_schedule half also means an EMPTY schedule gets no nag at all:
        // starring an act is one tap, but seeding the schedule means importing a
        // poster, which is too much to ask of whoever happens to land here. Don't
        // add a "your schedule is empty" nudge back — that was deliberately cut.
        // Silenced ON the schedule tab itself: pointing someone at the Schedule
        // while they are standing on it is noise, and the dog would sit over the
        // grid they came to read. Path-based (not activeTab) so the tab's own
        // fragment routes count too, and so dogSlotOob gets the same answer.
        const onScheduleTab = /^\/f\/\d+\/schedule/.test(c.req.path || '');
        const needSchedulePick = !!passes.has_schedule && !passes.mine && !onScheduleTab;

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
            key = 'passes';
            bubble = html`
              <span class="dog-title">Hey ${person.display_name}!</span>
              Don't forget ${owed}. Check ${it} off when you've got ${it}.
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/mine" ${raw(DESKTOP_HX)}>Go to my checklist</a></li>
              </ul>`;
        } else if (needSchedulePick) {
            // Set times are up but this person hasn't starred anyone.
            nag = 'schedule';
            key = 'schedule';
            bubble = html`
              <span class="dog-title">Who do you want to see?</span>
              You haven't picked any sets yet.
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/schedule" ${raw(DESKTOP_HX)}>Open the Schedule</a></li>
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
    <div class="dog-assistant" id="dog-assistant" data-dog-key="${key}"${nag ? html` data-dog-nag="${nag}"` : ''}>
      <div class="dog-bubble" id="dog-bubble" role="status">
        ${bubble}
        <button type="button" class="dog-go-away">
          <img class="dog-go-away-ico" src="/xp/logoff.png" alt="">Go away
        </button>
      </div>
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
          ${person
            ? html`<a class="xp-startmenu-item" href="/settings" onclick="campCloseStart()"
                hx-get="/settings/window" hx-target="#popup-layer" hx-swap="beforeend">
                <img class="xp-startmenu-ico" src="/xp/control-panel.png" alt=""> Control Panel</a>`
            : html`<a class="xp-startmenu-item" href="/signin?next=%2Fsettings" onclick="campCloseStart()"
                hx-get="/signin/modal?next=%2Fsettings" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
                <img class="xp-startmenu-ico" src="/xp/control-panel.png" alt=""> Control Panel</a>`}
          <a class="xp-startmenu-item" href="/admin" onclick="campCloseStart()">
            <img class="xp-startmenu-ico" src="/xp/admin.png" alt=""> Administrative Tools</a>
          ${festival ? html`
          <a class="xp-startmenu-item" href="/f/${festival.id}/log" onclick="campCloseStart()" ${raw(DESKTOP_HX)}>
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
        // Decorative, like every other tab's. ("Play" dropped — it was the one
        // menu label promising something the window can't do.)
        menus: ['File', 'View', 'Tools', 'Help'],
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
// Tab switching is an htmx swap of #desktop, NOT a full page load. The taskbar,
// wallpaper, stylesheet and camp.js all live outside the swap, so they survive
// untouched — which is the whole point: the tray icons used to visibly pop in on
// every switch because a full navigation tore the document down and re-fetched,
// re-decoded and re-painted them from scratch.
// The attributes sit on the <nav> and are INHERITED by every <a> inside it, so an
// icon only has to name its own hx-get. Anything in here that targets something
// else (the signed-out Log In icon) must override BOTH hx-target and hx-push-url —
// inheritance is per-attribute, so overriding only the target still pushes the URL.
// `show:window:top` reproduces what a real navigation does to scroll position;
// without it a swap keeps the old scroll offset and lands you mid-page.
//
// It MUST be hx-boost, not an hx-get per link. Boost is the only path in htmx that
// honours a cmd/ctrl-click, and it's structural, not cosmetic — the click handler runs
//     if (ft(a,e)) return;                 // boosted anchor + ctrl/meta -> native nav
//     if (l || ut(e,a)) e.preventDefault(); // cancels the browser's navigation
//     if (ct(s,a,e)) return;                // [trigger filters] — too late, already cancelled
// so with an explicit hx-get, `ft` is false, preventDefault fires, and a cmd-click gets
// swallowed: no new tab AND no swap. A `click[!metaKey]` trigger filter can't rescue it
// either, because filters are evaluated after preventDefault. Boost also means the link
// needs no hx-get at all — it just uses its own href, so href stays the single source of
// truth for where an icon goes, and no-JS / middle-click / refresh keep doing full loads.
const DESKTOP_HX = 'hx-boost="true" hx-target="#desktop" hx-swap="innerHTML show:window:top" hx-push-url="true"';

function desktopIcons(festival, activeTab, person) {
    const next = `/f/${festival.id}/mine`;
    return html`
    <nav class="desktop-icons" aria-label="sections" ${raw(DESKTOP_HX)}>
      ${Object.entries(TAB_THEMES).filter(([, t]) => !t.hidden).map(([key, t]) => {
        // Signed out, "About Me" has nothing to be about — so the icon becomes the
        // way IN instead of a tab that can only tell you to log on. Same slot, same
        // art size, and `next` points back here, so logging on lands you on About Me
        // with your stuff on it. The href is the no-JS path; htmx pops the box.
        const logon = key === 'mine' && !person;
        const ico = logon ? '/xp/logon.png' : t.ico;
        const href = logon ? `/signin?next=${encodeURIComponent(next)}` : `/f/${festival.id}/${t.path}`;
        return html`
        <a href="${href}"
          class="desk-icon ${key === activeTab ? 'active' : ''}"
          style="--ico:url('${ico}')" ${key === activeTab ? html`aria-current="page"` : ''}
          ${logon
            ? html`hx-get="/signin/modal?next=${encodeURIComponent(next)}" hx-target="#signin-modal-overlay"
                   hx-swap="innerHTML" hx-push-url="false"`
            : ''}>
          <span class="desk-icon-img"><img src="${ico}" alt=""></span>
          <span class="desk-icon-label">${logon ? 'Log In' : t.label}</span>
        </a>`;
    })}
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

    // EVERYTHING that differs between two tabs of the same festival, in one
    // contiguous block: the icon row (its selected state), any sibling window a
    // page docks above the main one, the main window itself, and the mine tab's
    // floating windows. This is exactly what a tab swap replaces — so anything
    // added here is automatically handled by both paths, and anything that must
    // SURVIVE a tab switch (taskbar, overlay layers, Rover) must stay out of it.
    const desktopInner = html`
  <!-- Icons first: they're the way into everything, so they sit directly under
       the taskbar with the program window right below. Rover is position:fixed
       bottom-right and renders last so he's out of the flow entirely. -->
  ${festival ? desktopIcons(festival, activeTab, person) : ''}
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
  <div id="mine-floating" class="mine-floating">${floatingHtml}</div>`;

    // A tab swap: send the new desktop and nothing else. Identified by HX-Target
    // rather than a bare HX-Request check, because plenty of OTHER htmx requests
    // hit these same URLs (fragment refreshes aimed at #main, #car-list, …) and
    // must still get their own markup, not a whole desktop.
    // HX-History-Restore-Request is excluded deliberately: on a history restore
    // whose snapshot has been evicted from localStorage, htmx re-requests the URL
    // and replaces the entire <body> with the response — so that one MUST be the
    // full page or the taskbar and overlay layers vanish.
    const isTabSwap = c.req.header('HX-Target') === 'desktop'
        && c.req.header('HX-History-Restore-Request') !== 'true';
    if (isTabSwap) {
        // htmx pulls document.title out of any response containing a <title> tag,
        // so the tab name tracks the swap without a line of client JS.
        // Rover rides along out-of-band: what he has to say is per-tab (he goes
        // quiet on the Schedule tab), and he lives outside #desktop so that a
        // fragment swap of the page body can't disturb him. `passes` is already in
        // hand from the chrome batch, so this costs no extra query.
        return html`<title>${title} :: camp planner</title>${desktopInner}
  <div id="dog-slot" hx-swap-oob="outerHTML">${dogHtml}</div>`;
    }

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
  <!-- Stylesheet FIRST: it's the only render-blocking resource that actually
       gates first paint, and behind the two scripts the browser didn't even start
       fetching it until they'd been downloaded and run. -->
  <link rel="stylesheet" href="/retro.css">
  <!-- historyCacheSize:0 — tab switches push URLs, and on every push htmx snapshots
       the ENTIRE body innerHTML into localStorage. The stuff page is ~390 KB raw
       (it compresses to ~11 KB on the wire, but the snapshot is the raw string), so
       the default cache of 10 would try to hold ~4 MB. localStorage tops out around
       5 MB, and htmx's response to a quota error is to drop an entry and re-stringify
       the whole array — megabytes of JSON serialisation on every single tab click,
       which is precisely the jank the htmx swap exists to remove.
       With the cache off, Back/Forward re-requests the URL with
       HX-History-Restore-Request, and renderPage answers that with the full page —
       consistent with this app already forcing a network fetch per navigation
       (no-store, see app.js). Raise this only if the pages get much smaller. -->
  <meta name="htmx-config" content='{"historyCacheSize":0}'>
  <script>window.PIXMOJI_RANGES=${raw(JSON.stringify(PIXMOJI_COVERED_RANGES))};</script>
  <!-- Both deferred: neither is needed while the HTML parses, and the stuff page
       is a lot of HTML to hold up. Deferred scripts still run in order and still
       run BEFORE DOMContentLoaded, which is all either one needs — camp.js binds
       to the document object (never document.body) and does its DOM work from
       DOMContentLoaded/htmx events, htmx wires itself up on DOMContentLoaded, and
       the inline onclick= handlers in the body only fire on a real tap. There are
       no inline <script> blocks in the body to trip over this.
       Self-hosted htmx (was unpkg): first paint shouldn't wait on a third-party
       CDN's DNS + TLS + fetch. Version in the filename + immutable cache
       (public/_headers); bump the name when upgrading htmx. camp.js's freshness
       comes from Cache-Control: no-cache + ETag — revalidated each load, 304
       unless it changed. -->
  <script src="/htmx-1.9.12.min.js" defer></script>
  <script src="/camp.js" defer></script>
</head>
<body>
  ${taskbar(c, festival, festivals)}
  <div class="title-gap" aria-hidden="true"></div>
  <!-- The three overlay layers sit ABOVE #desktop in the document so a tab swap
       can't blow away an open modal, popup or toast. Position is unaffected: all
       three are position:fixed at z-index 999/1000 and display:none while empty,
       so DOM order among them and the flow content below is irrelevant. -->
  <div id="signin-modal-overlay"></div>
  <div id="popup-layer"></div>
  <div id="toast"></div>
  <div id="desktop">${desktopInner}</div>
  ${dogSlot(dogHtml)}
  <div class="site-foot-space" aria-hidden="true"></div>
  ${msnToolbarTemplate()}
</body>
</html>`;
}
