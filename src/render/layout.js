import { html, raw } from 'hono/html';
import { PIXMOJI_COVERED_RANGES } from './pixmoji-coverage.js';
import { xpCaptionBtns } from './popup.js';

export function tickerHtml(entries) {
    if (!entries || !entries.length) {
        return html`<div class="marquee-wrap"><div class="marquee-track"><span class="marquee" style="animation-duration:20s">There are no announcements to display. Be the first to do something!</span></div></div>`;
    }
    const text = entries.map((e) => e.summary).join('   ·   ');
    // Duration scales with content length so the scroll speed (px/sec) stays roughly
    // constant instead of whipping faster as more news accumulates.
    const duration = Math.max(25, Math.round(text.length / 6));
    return html`<div class="marquee-wrap"><div class="marquee-track"><span class="marquee" style="animation-duration:${duration}s">${text}&nbsp;&nbsp;·&nbsp;&nbsp;${text}</span></div></div>`;
}

// Rover's idle chatter: once there's nothing important to say, he rotates through
// helpful tips instead of going quiet: feedback, the control panel, ghost people,
// merging duplicates, the MSN emoticons, and one tip that is definitely not a hint
// about what happens if you pet him five times (see public/camp.js). Voice: Rover
// himself, first-person and cheery, the way the XP Search Companion always talked.
// No em dashes anywhere in his copy.
function dogTip(festival) {
    const tips = [
        {
            title: 'Your opinion counts!',
            body: html`Found a problem, or have a bright idea? Tell me all about it! Click <b>Start</b>, and then click <b>Send Feedback</b>, and I'll go fetch it straight to the folks who look after camp planner.`,
            links: html`<li><a href="/feedback" hx-get="/feedback/window" hx-target="#popup-layer" hx-swap="beforeend">Send feedback now</a></li>`,
        },
        {
            title: "Let's make it yours",
            body: html`Did you know you can switch between 12-hour and 24-hour time, manage your e-mail notifications, and even turn the confetti on or off? Click <b>Start</b>, and then click <b>Control Panel</b>.`,
            links: html`<li><a href="/settings" hx-get="/settings/window" hx-target="#popup-layer" hx-swap="beforeend">Open Control Panel</a></li>`,
        },
        {
            title: 'A blast from the past',
            body: html`Here is a fun one for you: every chat window uses the original MSN Messenger emoticons. Try typing <b>:)</b> or <b>(Y)</b> or <b>(8)</b> in a message and watch what I do. Some things never go out of style!`,
        },
        {
            title: 'A note from Rover',
            body: html`I am a professional Search Companion with an important job to do. Please do not pet me five times in a row. Nothing bad will happen. I am simply asking you not to.`,
        },
    ];
    if (festival) {
        tips.push({
            title: 'Bringing a friend?',
            body: html`Bringing a friend who hasn't signed up yet? Open <b>People</b>, click <b>Add Person</b>, and type their name. That's all there is to it!`,
            links: html`<li><a href="/f/${festival.id}/ppl">Open People</a></li>`,
        });
        tips.push({
            title: 'Seeing double?',
            body: html`Uh oh, did someone sign in under two different names? Not to worry. Open <b>People</b>, click <b>Merge</b>, and pick both entries, and I'll roll them into one camper without losing a single thing.`,
            links: html`<li><a href="/f/${festival.id}/ppl">Open People</a></li>`,
        });
        tips.push({
            title: 'Made a mistake? You can undo it!',
            body: html`Not to worry, I keep track of almost everything, and I can take it right back for you. Open the <b>Log</b> and click <b>undo</b> next to the entry. Changed your mind again? You can even undo an undo. Just click <b>redo</b> and it pops right back. Nothing is ever really lost!`,
            links: html`<li><a href="/f/${festival.id}/log">Open the Log</a></li>`,
        });
    }
    const t = tips[Math.floor(Math.random() * tips.length)];
    return html`
      <span class="dog-title">${t.title}</span>
      ${t.body}
      ${t.links ? html`<ul class="dog-links">${t.links}</ul>` : ''}`;
}

// Rover the XP Search Companion: a contextual assistant tip. Not signed in → nudge
// to sign in; signed in on a fest → remind about the passes they still owe. Copy
// is written in cheery early-2000s Windows-helper voice. When there's nothing
// important left to say (passes done, or signed in off a fest page), he falls
// back to the rotating dogTip() pool above instead of disappearing.
async function dogAssistant(c, festival, person) {
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
        const db = c.env.DB;
        // Rover's fest-page reminders cost exactly two round trips, fired together so
        // wall time is the slower one. This runs on EVERY festival page for every
        // signed-in member, so every extra query here is latency on every navigation —
        // hence the driver check, the schedule check and the interest check are folded
        // into one single-row query rather than three separate ones.
        const [passRows, flags] = await Promise.all([
            // Which default passes has this person actually checked off?
            db.prepare(`
                SELECT t.label FROM checklist_tasks t
                JOIN checklist_checks cc ON cc.task_id = t.id AND cc.person_id = ? AND cc.unchecked_at IS NULL
                WHERE t.festival_id = ? AND t.is_default = 1 AND t.deleted_at IS NULL
            `).bind(person.id, festival.id).all().then((r) => r.results),
            // One row, three yes/no flags (?1 = fest, ?2 = person): are they a driver
            // (only drivers owe a car pass), does the fest have a schedule at all, and
            // have they starred any set on it? On failure fall back to an empty row, so
            // every flag reads falsy and Rover simply says nothing.
            db.prepare(`
                SELECT
                  EXISTS(SELECT 1 FROM cars
                         WHERE festival_id = ?1 AND driver_person_id = ?2 AND deleted_at IS NULL) AS driving,
                  EXISTS(SELECT 1 FROM schedule_sets
                         WHERE festival_id = ?1 AND deleted_at IS NULL) AS has_schedule,
                  EXISTS(SELECT 1 FROM set_interests si
                         JOIN schedule_sets ss ON ss.id = si.set_id
                         WHERE ss.festival_id = ?1 AND si.person_id = ?2 AND si.deleted_at IS NULL) AS mine
            `).bind(festival.id, person.id).first().catch(() => ({})),
        ]);
        const got = new Set(passRows.map((r) => (r.label || '').toLowerCase()));
        const needFestPass = !got.has('festival pass');
        const needCarPass = !!(flags && flags.driving) && !got.has('car pass');
        // Fest has set times posted, but this person hasn't starred a single act.
        const needSchedulePick = !!(flags && flags.has_schedule && !flags.mine);

        if (needFestPass || needCarPass) {
            const passes = needCarPass
                ? html`your <b>festival pass</b> and <b>car pass</b>`
                : html`your <b>festival pass</b>`;
            bubble = html`
              <span class="dog-title">Hey ${person.display_name}!</span>
              Have you picked up ${passes} yet? Once you've got ${needCarPass ? 'them' : 'it'}, just check ${needCarPass ? 'them' : 'it'} off your list and I'll mark you as all set.
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/mine">Go to my checklist</a></li>
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
            // Passes done and at least one act starred → idle tips.
            bubble = dogTip(festival);
        }
    } else {
        // Signed in but not on a fest page (the festival list, settings, …) —
        // Rover has nothing urgent, so he shares a tip.
        bubble = dogTip(null);
    }
    return html`
    <div class="dog-assistant">
      <div class="dog-bubble">${bubble}</div>
      <img class="dog-img" src="/dog.webp" alt="Rover the assistant dog">
    </div>`;
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
export async function renderPage(c, { title, activeTab = '', body, festival = null, floating = '', pre = '', bare = false, windowTitle = null }) {
    const db = c.env.DB;
    const person = c.get('person');

    // The page chrome needs four independent lookups; fire them together so the
    // wall time is the slowest one, not the sum. Failures degrade the same way
    // the old sequential try/catches did.
    const [festivals, ticker, membership, dogHtml] = await Promise.all([
        db.prepare('SELECT id, name FROM festivals WHERE deleted_at IS NULL ORDER BY name').all()
            .then((r) => r.results).catch(() => []),
        festival
            ? db.prepare(`
                SELECT summary FROM audit_log
                WHERE festival_id = ? AND action != 'undo'
                ORDER BY created_at DESC LIMIT 15
              `).bind(festival.id).all().then((r) => r.results).catch(() => [])
            : [],
        // Signed-in-but-not-a-member of the fest you're looking at → offer to join.
        // On lookup failure pretend they're a member so we don't flash the banner.
        festival && person
            ? db.prepare('SELECT 1 FROM memberships WHERE festival_id = ? AND person_id = ? AND bailed_at IS NULL')
                .bind(festival.id, person.id).first().catch(() => 1)
            : 1,
        dogAssistant(c, festival, person),
    ]);
    const showJoin = !membership;

    const theme = (festival && TAB_THEMES[activeTab]) || null;
    // windowTitle lets themeless pages (admin, unsubscribe…) name their own
    // window instead of getting the generic fallback.
    const winTitle = windowTitle || (theme ? theme.title(festival) : `${festival ? festival.name : 'camp planner'} — Camp Planner`);

    return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  ${dogHtml}
  <div id="signin-modal-overlay"></div>
  <div id="popup-layer"></div>
  <div id="toast"></div>
  ${festival ? desktopIcons(festival, activeTab) : ''}
  ${pre}
  ${bare && !showJoin ? html`<main id="main" hidden>${body}</main>` : html`
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
      ${tickerHtml(ticker)}
      ${showJoin ? html`
        <div class="join-banner">
          <span class="join-banner-text">You are browsing <b>${festival.name}</b> as a guest — you are not on the list yet.</span>
          <form method="post" action="/f/${festival.id}/join" class="join-banner-form">
            <button class="btn btn-primary" type="submit">✔ i'm going!</button>
          </form>
        </div>` : ''}
      <main id="main">
        ${body}
      </main>
    </div>
  </div>`}
  <div id="mine-floating" class="mine-floating">${floating}</div>
  <div class="site-foot-space" aria-hidden="true"></div>
</body>
</html>`;
}
