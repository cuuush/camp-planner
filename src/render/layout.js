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
// XP-help-style tips instead of going quiet — feedback, the control panel, ghost
// people, merging duplicates, the MSN emoticons, and one tip that is definitely
// not a hint about what happens if you pet him five times (see public/camp.js).
// Voice: authentic "click Start, and then click…" Windows XP help text.
function dogTip(festival) {
    const tips = [
        {
            title: 'Your opinion counts!',
            body: html`camp planner is always looking for ways to improve. To report a problem or share an idea, click <b>Start</b>, and then click <b>Send Feedback</b>. Your report helps make camping better for everyone.`,
            links: html`<li><a href="/feedback" hx-get="/feedback/window" hx-target="#popup-layer" hx-swap="beforeend">Send feedback now</a></li>`,
        },
        {
            title: 'Personalize camp planner',
            body: html`Did you know you can switch between 12-hour and 24-hour time, manage e-mail notifications, and turn confetti on or off? Click <b>Start</b>, and then click <b>Control Panel</b> to make camp planner truly yours.`,
            links: html`<li><a href="/settings" hx-get="/settings/window" hx-target="#popup-layer" hx-swap="beforeend">Open Control Panel</a></li>`,
        },
        {
            title: 'A blast from 2003',
            body: html`The emoticons in every chat window are the original MSN Messenger graphics. Try typing <b>:)</b> or <b>(Y)</b> or <b>(8)</b> in a message. Some things never go out of style.`,
        },
        {
            title: 'A note from Rover',
            body: html`I am a professional Search Companion with an important job to do. Please do not pet me five times in a row. Nothing bad will happen. I am simply asking you not to.`,
        },
    ];
    if (festival) {
        tips.push({
            title: 'Bringing a friend?',
            body: html`You can add people who haven't signed up yet. Open <b>People</b>, click <b>Add Person</b>, and type their name. When they sign in with that name later, everything they were given links up automatically.`,
            links: html`<li><a href="/f/${festival.id}/ppl">Open People</a></li>`,
        });
        tips.push({
            title: 'Seeing double?',
            body: html`If a camper accidentally signs in under two different names, open <b>People</b>, click <b>Merge</b>, and select both entries. They will be combined into one camper, and nothing they did is lost.`,
            links: html`<li><a href="/f/${festival.id}/ppl">Open People</a></li>`,
        });
        tips.push({
            title: 'Made a mistake? You can undo it!',
            body: html`Almost everything that happens here is recorded and reversible. To take something back, open the <b>Log</b> and then click <b>undo</b> next to the entry. Changed your mind again? You can even undo an undo — click <b>redo</b> and it comes right back. Nothing is ever really lost.`,
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
          <span class="dog-title">Hi there — I'm Rover!</span>
          It looks like you're just visiting. Sign in and you can claim what you're bringing and save a seat in a carpool.
          <ul class="dog-links">
            <li><a href="/signin?next=${next}" hx-get="/signin/modal?next=${next}" hx-target="#signin-modal-overlay" hx-swap="innerHTML">Sign in &amp; join this fest</a></li>
          </ul>`;
    } else if (festival) {
        const db = c.env.DB;
        const [driving, passRows] = await Promise.all([
            // Only drivers owe a car pass, so only nag drivers about it.
            db.prepare('SELECT 1 FROM cars WHERE festival_id = ? AND driver_person_id = ? AND deleted_at IS NULL')
                .bind(festival.id, person.id).first(),
            // Which default passes has this person actually checked off?
            db.prepare(`
                SELECT t.label FROM checklist_tasks t
                JOIN checklist_checks cc ON cc.task_id = t.id AND cc.person_id = ? AND cc.unchecked_at IS NULL
                WHERE t.festival_id = ? AND t.is_default = 1 AND t.deleted_at IS NULL
            `).bind(person.id, festival.id).all().then((r) => r.results),
        ]);
        const got = new Set(passRows.map((r) => (r.label || '').toLowerCase()));
        const needFestPass = !got.has('festival pass');
        const needCarPass = !!driving && !got.has('car pass');

        // All set (festival pass done; car pass done or not needed) → idle tips.
        if (!needFestPass && !needCarPass) {
            bubble = dogTip(festival);
        } else {
            const passes = needCarPass
                ? html`your <b>festival pass</b> and <b>car pass</b>`
                : html`your <b>festival pass</b>`;
            bubble = html`
              <span class="dog-title">Hey ${person.display_name}!</span>
              Did you remember to buy ${passes}? Once you've got ${needCarPass ? 'them' : 'it'}, check ${needCarPass ? 'them' : 'it'} off your list.
              <ul class="dog-links">
                <li><a href="/f/${festival.id}/mine">Go to my checklist</a></li>
              </ul>`;
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
        title: (f) => `What we are bringing to ${f.name}`,
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
    mine: {
        label: 'About Me', path: 'mine', ico: '/xp/desk-me.png',
        title: (f) => `About Me - ${f.name}`,
        menus: ['File', 'Edit', 'View', 'Help'],
    },
    log: {
        label: 'Log', path: 'log', ico: '/xp/desk-log.png',
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
      ${Object.entries(TAB_THEMES).map(([key, t]) => html`
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
export async function renderPage(c, { title, activeTab = '', body, festival = null, floating = '', pre = '', bare = false }) {
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
    const winTitle = theme ? theme.title(festival) : `${festival ? festival.name : 'camp planner'} — Camp Planner`;

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
  <div class="xp-window">
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
