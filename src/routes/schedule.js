import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival, membershipStatement } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { sqlNow, createEffect, deleteEffect, fieldEffects } from '../lib/effects.js';
import { notify } from '../lib/notify.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { loadComments, handleCommentPost } from '../lib/comments.js';
import { msnChat, escapeHtml } from '../render/msn.js';
import { xpPopup, xpDialogPopup } from '../render/popup.js';
import { takeApiBudget, SCHEDULE_VISION_MONTHLY_LIMIT } from '../lib/budget.js';
import {
    fmtSetRange, fmtHourLabel, clockToMin, minToClockFields,
    loadDays, loadDaySets, loadSet, applyInterestRows, buildGrid, stageColor,
} from '../lib/schedule.js';
import { parseScheduleImage, normalizeParsedSets } from '../lib/scheduleParse.js';
import { resolveSpotifyLink, parseSpotifyUrl, setSpotifyLink, splitArtists, attachSpotifyLinks } from '../lib/spotify.js';
import { replaceDaySets, publishSchedule, adoptPublication, listPublications } from '../lib/scheduleShare.js';

export const schedule = new Hono();

// Grid geometry. One hour is HOUR_H px tall; a set's tile is placed and sized in px
// from its start/end minutes so tiles across every stage line up against the shared
// ruler (like the poster). MIN_TILE_H keeps a very short set tall enough to tap.
const HOUR_H = 88;
const PX_PER_MIN = HOUR_H / 60;
const MIN_TILE_H = 30;
// At or below this height a tile shows the artist ONLY (see scheduleTile). 36px is
// just under a 25-minute slot, so it catches the 15/20-minute oddities — an opening
// ceremony, a B2B changeover — without touching a normal half-hour set.
const TIGHT_TILE_H = 36;

// ——— classic-XP "operation complete" notice, ridden along OOB into #popup-layer ———
function successDialog({ title = 'Windows Media Player', icon = 'success', message }) {
    return html`<div hx-swap-oob="beforeend:#popup-layer">${xpDialogPopup({
        title, id: 'sched-note', icon, message,
        buttons: html`<button class="btn btn-primary" type="button" onclick="closePopup(this)">OK</button>`,
    })}</div>`;
}

// ——————————————————————————————— grid rendering —————————————————————————————————

// One positioned set tile. Collapsed it's dense — artist, time, and who's going.
// Tapping the head expands the card IN PLACE (raised, floating over its neighbours)
// to reveal its buttons; no pop-out window. `edit` mode is the exception: there a
// tap opens the buried edit popup instead.
function scheduleTile(festival, set, minMin, { edit = false } = {}) {
    const top = Math.round((set.start_min - minMin) * PX_PER_MIN);
    const height = Math.max(MIN_TILE_H, Math.round((set.end_min - set.start_min) * PX_PER_MIN));
    const color = stageColor(set.stage, set.stage_order || 0);
    const style = `top:${top}px; height:${height}px; --stage:${color}`;
    // A 15-minute slot ("Opening Ceremony") is MIN_TILE_H tall — ~24px of content
    // once the head's padding is off. The artist line alone is ~13px and the time
    // another ~11px, so they don't both fit, and a name that wraps to two lines
    // bursts the tile. Below the cutoff the CSS shows the name only, smaller: the
    // name is what you scan for, and the time is still on the ruler right beside it
    // (and in the card once you open it, which restores everything).
    const tight = height <= TIGHT_TILE_H;

    if (edit) {
        return html`
        <button type="button" class="sched-tile editing" id="set-tile-${set.id}" style="${style}"
          hx-get="/f/${festival.id}/schedule/set/${set.id}/edit-window" hx-target="#popup-layer" hx-swap="beforeend">
          <span class="sched-tile-artist">${set.artist}</span>
          <span class="sched-tile-time">${fmtSetRange(set.start_min, set.end_min)}</span>
          <span class="sched-tile-editcue">✎</span>
        </button>`;
    }
    // No "mine" class: the tint is driven off the going-button by :has() in the CSS.
    // Marking interest only swaps the actions block INSIDE this tile, so a class out
    // here would go stale until a reload — which is exactly what it used to do.
    return html`
    <div class="sched-tile ${tight ? 'tight' : ''}" id="set-tile-${set.id}" style="${style}">
      <button type="button" class="sched-tile-head" onclick="campToggleSetTile(this)">
        <span class="sched-tile-artist">${set.artist}</span>
        <span class="sched-tile-time">${fmtSetRange(set.start_min, set.end_min)}</span>
        <span class="sched-tile-who-inline" id="set-who-${set.id}">${whoInline(set)}</span>
      </button>
      <div class="sched-tile-body">
        <div class="sched-tile-actions" id="set-actions-${set.id}">${setActions(festival, set)}</div>
      </div>
    </div>`;
}

// The interested people, listed right on the card face under the time so you can
// see who's going at a glance. Empty string when no one's marked it.
function whoInline(set) {
    if (!set.interest_count) return '';
    return html`${set.interested.join(', ')}`;
}

// The buttons inside an expanded card. Marking interest dismisses the card (the
// name then shows on its collapsed face); Chat pops out a real chat window.
//
// The going state is a LATCHED button — pressed-in with a ticked checkbox, the way
// XP's toolbar toggles (Explorer's Folders button) showed they were on. It has to
// carry its own undo: the label alone said "You're Going", which reads as a status
// and gives you nothing to click back. The checkbox is the part doing that work —
// a ticked box means "click to untick" to everyone, with no hover needed (this card
// spends most of its life under a thumb).
function setActions(festival, set) {
    return html`
      <form hx-post="/f/${festival.id}/schedule/set/${set.id}/interest" hx-target="#set-actions-${set.id}" hx-swap="outerHTML"
        hx-disabled-elt="find button"
        hx-on::after-request="if(event.detail.successful) campCollapseSetTiles(null)">
        <button class="btn sched-act-btn ${set.i_interested ? 'sched-going' : 'btn-primary'}" type="submit"
          aria-pressed="${set.i_interested ? 'true' : 'false'}"
          title="${set.i_interested ? 'Click to take yourself off this set' : 'Add yourself to this set'}"
          >${set.i_interested ? html`<span class="xp-checkbox checked" aria-hidden="true"></span>You're Going` : "I'm Interested"}</button>
      </form>
      ${spotifyAction(festival, set)}
      ${chatButton(festival, set, set.comment_count || 0)}`;
}

// The card's chat button. The count comes in as an argument rather than off `set`
// because after a post the freshly-loaded comment list is the only current source.
// oob=true re-emits it into the card sitting behind the chat window — the card is
// only collapsed, not gone, so the id is still there to swap. Without this the
// button keeps whatever count it rendered with until a reload.
function chatButton(festival, set, count, { oob = false } = {}) {
    return html`
      <button class="btn sched-act-btn sched-chat-btn" type="button" id="set-chat-btn-${set.id}"
        ${oob ? html`hx-swap-oob="true"` : ''}
        onclick="campCollapseSetTiles(null)"
        hx-get="/f/${festival.id}/schedule/set/${set.id}/chat-window" hx-target="#popup-layer" hx-swap="beforeend">
        Chat (${count} message${count === 1 ? '' : 's'})</button>`;
}

// "Play on Spotify". Three states, driven by the cache (see src/lib/spotify.js):
//  • known link  → a green anchor straight to the artist's Spotify page.
//  • cached miss → a quiet note; there is nothing to link to, so no dead button.
//  • unknown     → a button that looks the link up on tap (campSpotifyPlay), then
//                  saves it. Costs one search, once, for the first person to tap a
//                  given artist anywhere — after that it's cached for every camp
//                  and renders as one of the two states above.
function spotifyAction(festival, set) {
    // Two acts on one slot ("SULLIVAN KING b2b KAYZO"): there's no single right
    // answer, so never guess one — always ask. (Guessing is what it did before:
    // the full string searches to whichever member Spotify ranks first.)
    if ((set.spotify_artists || []).length > 1) {
        return html`
          <button class="btn sched-act-btn sched-spotify" type="button"
            hx-get="/f/${festival.id}/schedule/set/${set.id}/spotify-pick" hx-target="#popup-layer" hx-swap="beforeend">
            Play on Spotify</button>`;
    }
    if (set.spotify_url) return spotifyLink(set.spotify_url);
    if (set.spotify_checked) return spotifyMissing();
    return html`
      <button class="btn sched-act-btn sched-spotify" type="button"
        data-resolve="/f/${festival.id}/schedule/set/${set.id}/spotify"
        onclick="campSpotifyPlay(this)">Play on Spotify</button>`;
}

// "Who do you want to hear?" — XP asked a question with the blue ? bubble and one
// button per answer, so that's what this is: a real message box, a button per act,
// Cancel last. Each choice is an ordinary campSpotifyPlay button pointed at that one
// artist, so it inherits the whole find → open (or "Click me!") dance for free.
schedule.get('/f/:id/schedule/set/:setId/spotify-pick', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    const { festival, set } = loaded;
    const choices = splitArtists(set.artist);
    if (choices.length < 2) return c.html('');
    return c.html(xpDialogPopup({
        title: 'Play on Spotify',
        id: `spotify-pick-${set.id}`,
        icon: 'question',
        message: html`<b>${set.artist}</b> is ${choices.length === 2 ? 'two artists' : `${choices.length} artists`} playing one set. Who do you want to hear?`,
        buttons: html`
          ${choices.map((name) => html`
            <button class="btn sched-spotify" type="button"
              data-resolve="/f/${festival.id}/schedule/set/${set.id}/spotify?artist=${encodeURIComponent(name)}"
              onclick="campSpotifyPlay(this)">${name}</button>`)}
          <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>`,
    }));
});

function spotifyLink(url) {
    return html`<a class="btn sched-act-btn sched-spotify" href="${url}" target="_blank" rel="noopener noreferrer">Play on Spotify</a>`;
}

function spotifyMissing() {
    return html`<span class="sched-act-btn sched-spotify-none">Not on Spotify</span>`;
}

// The poster-style grid: a sticky time ruler on the left, then a horizontally
// scrollable row of stage columns whose tiles are positioned against the ruler.
function scheduleGrid(festival, sets, edit = false) {
    const { stages, minMin, maxMin } = buildGrid(sets);
    const totalH = Math.round((maxMin - minMin) * PX_PER_MIN);
    const hours = [];
    for (let h = minMin; h <= maxMin; h += 60) hours.push(h);

    return html`
    <div class="sched-scroll">
      <div class="sched-grid" style="--hour-h:${HOUR_H}px">
        <div class="sched-ruler">
          <!-- Empty on purpose: the day buttons above the grid already say which day
               this is, and the corner still has to exist to hold the ruler down to
               the same height as the stage headings beside it. -->
          <div class="sched-corner"></div>
          <div class="sched-ruler-body" style="height:${totalH}px">
            ${hours.map((h) => html`<div class="sched-hour" style="top:${Math.round((h - minMin) * PX_PER_MIN)}px">${fmtHourLabel(h)}</div>`)}
          </div>
        </div>
        <div class="sched-stages">
          ${stages.map((col) => html`
            <div class="sched-col" style="--stage:${stageColor(col.name, col.order)}">
              <div class="sched-col-head">${col.name || 'Set Times'}</div>
              <div class="sched-col-body" style="height:${totalH}px">
                ${col.sets.map((s) => scheduleTile(festival, s, minMin, { edit }))}
              </div>
            </div>`)}
        </div>
      </div>
    </div>`;
}

// The "no schedule yet" state — WMP's empty library, with the two ways to get one.
function scheduleEmpty(festival) {
    return html`
    <div class="sched-empty">
      <img class="sched-empty-ico" src="/xp/desk-schedule.png" alt="" width="56" height="56">
      <p class="sched-empty-title">There is nothing on the schedule yet.</p>
      <p class="sched-empty-sub">Upload a photo of the set times and Windows Media Player will read them for you, or load a schedule another camp has already shared.</p>
      <div class="sched-empty-actions">
        <button class="btn btn-primary" type="button" hx-get="/f/${festival.id}/schedule/import-window" hx-target="#popup-layer" hx-swap="beforeend">Import Schedule…</button>
        <button class="btn" type="button" hx-get="/f/${festival.id}/schedule/load-window" hx-target="#popup-layer" hx-swap="beforeend">Load a Shared Schedule…</button>
      </div>
    </div>`;
}

// Normal-mode toolbar: kept intentionally sparse for density. Getting/replacing a
// schedule and fixing it are buried under "Edit Schedule" (edit mode) so the day-to-
// day view is just the grid + interest.
// `day` rides along on every mode switch — without it the swap re-renders with no
// day param and silently drops you back on day one, which is maddening when you're
// editing Sunday.
function scheduleToolbar(festival, day) {
    return html`
    <div class="sched-toolbar">
      <button class="btn sched-tbtn" type="button" hx-get="/f/${festival.id}/schedule/body?edit=1&day=${encodeURIComponent(day || '')}" hx-target="#sched-body" hx-swap="outerHTML">
        <img class="sched-tbtn-ico" src="/xp/desk-schedule.png" alt="">Edit Schedule…</button>
    </div>`;
}

// Edit-mode banner — where all the schedule-building actions live (only really
// needed right after you first create a schedule). "Done" drops back to view mode.
function editBanner(festival, day) {
    return html`
    <div class="sched-editbar">
      <span class="sched-editbar-text"><b>Editing schedule.</b> Tap a set to change it.</span>
      <span class="sched-editbar-actions">
        <button class="btn sched-tbtn" type="button" hx-get="/f/${festival.id}/schedule/add-window?day=${encodeURIComponent(day || '')}" hx-target="#popup-layer" hx-swap="beforeend">Add Set…</button>
        <button class="btn sched-tbtn" type="button" hx-get="/f/${festival.id}/schedule/import-window" hx-target="#popup-layer" hx-swap="beforeend">Import…</button>
        <button class="btn sched-tbtn" type="button" hx-get="/f/${festival.id}/schedule/load-window" hx-target="#popup-layer" hx-swap="beforeend">Load Shared…</button>
        <button class="btn sched-tbtn" type="button" hx-get="/f/${festival.id}/schedule/share-window" hx-target="#popup-layer" hx-swap="beforeend">Share…</button>
        <button class="btn btn-primary sched-tbtn" type="button" hx-get="/f/${festival.id}/schedule/body?day=${encodeURIComponent(day || '')}" hx-target="#sched-body" hx-swap="outerHTML">Done</button>
      </span>
    </div>`;
}

// The big day switcher across the top — the primary control on the tab, so it's
// large and tap-sized, and styled nothing like the small grey "Edit Schedule…"
// button it sits beside. Swaps just the grid via htmx but keeps a real href, so
// a day is still linkable/shareable and works without JS.
//
// A button per day GROUP, including one whose day couldn't be read (empty label) —
// otherwise importing a second, labeled day ("Saturday") would leave the first,
// unlabeled day (a Friday poster that never printed its day) with no tab at all,
// stranding its sets out of view as if they'd been overwritten. Only hidden when
// there's a single unlabeled day: one day, no label, nothing to switch between.
function dayButtons(festival, days, active, edit) {
    if (days.length < 2 && !days.some((d) => d)) return '';
    return html`
    <div class="sched-days">
      ${days.map((d) => {
        const q = encodeURIComponent(d);
        return html`<a class="sched-day ${d === active ? 'active' : ''}" href="/f/${festival.id}/schedule?day=${q}"
          hx-get="/f/${festival.id}/schedule/body?day=${q}${edit ? '&edit=1' : ''}" hx-target="#sched-body" hx-swap="outerHTML"
          hx-push-url="/f/${festival.id}/schedule?day=${q}">${d || 'Set Times'}</a>`;
    })}
    </div>`;
}

// #sched-body — everything inside the Media Player window's work area. Every
// mutation returns this so the grid refreshes in place. `edit` renders the buried
// edit mode (edit banner + tiles that open the editor).
async function scheduleBody(c, festival, dayParam, { edit = false } = {}) {
    const db = c.env.DB;
    const person = c.get('person');
    // With an explicit day (every day-tab click) the two loads don't depend on
    // each other, so they overlap. Only a bare visit needs days first, to know
    // which day is "first".
    let days, day, sets;
    if (dayParam != null && dayParam !== '') {
        day = dayParam;
        [days, sets] = await Promise.all([loadDays(db, festival.id), loadDaySets(db, festival.id, day, person)]);
    } else {
        days = await loadDays(db, festival.id);
        day = days[0] ?? '';
        sets = await loadDaySets(db, festival.id, day, person);
    }
    const hasSets = sets.length > 0;
    return html`
    <div id="sched-body" class="sched-body ${edit ? 'is-editing' : ''}">
      ${hasSets ? html`<div class="sched-top">
        ${dayButtons(festival, days, day, edit)}
        ${edit ? '' : scheduleToolbar(festival, day)}
      </div>` : ''}
      ${hasSets && edit ? editBanner(festival, day) : ''}
      ${hasSets ? scheduleGrid(festival, sets, edit) : scheduleEmpty(festival)}
    </div>`;
}

schedule.get('/f/:id/schedule', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await scheduleBody(c, festival, c.req.query('day'));
    return c.html(await renderPage(c, { title: `${festival.name} — Schedule`, festival, activeTab: 'schedule', body }));
});

// #sched-body fragment — the "Edit Schedule" / "Done" toggle swaps this in.
schedule.get('/f/:id/schedule/body', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    return c.html(await scheduleBody(c, festival, c.req.query('day'), { edit: c.req.query('edit') === '1' }));
});

// ————————————————————————— set card: interest + chat —————————————————————————

// The editable fields shared by "Add Set" and the edit popup. A time is an
// <input type="time"> (24h) plus an "after midnight" box, since a festival night
// crosses midnight and stored minutes go past 1440.
// `day` seeds a brand-new set with the day you're looking at — Add Set… is reached
// from that day's banner, so anything else is a wrong guess.
function setFields(set, day = '') {
    const s = minToClockFields(set ? set.start_min : null);
    const e = minToClockFields(set ? set.end_min : null);
    return html`
      <div class="edit-field"><label>Artist:</label><input type="text" name="artist" value="${set ? set.artist : ''}" placeholder="Rezz" required></div>
      <div class="edit-field"><label>Stage:</label><input type="text" name="stage" value="${set ? (set.stage || '') : ''}" placeholder="Fire"></div>
      <div class="edit-field"><label>Day:</label><input type="text" name="day" value="${set ? (set.day || '') : day}" placeholder="Friday"></div>
      <div class="edit-field"><label>Starts:</label>
        <span class="set-time-input"><input type="time" name="start" value="${s.time}">
          <label class="set-nextday"><input type="checkbox" name="start_am" ${s.afterMidnight ? 'checked' : ''}> after midnight</label></span></div>
      <div class="edit-field"><label>Ends:</label>
        <span class="set-time-input"><input type="time" name="end" value="${e.time}">
          <label class="set-nextday"><input type="checkbox" name="end_am" ${e.afterMidnight ? 'checked' : ''}> after midnight</label></span></div>`;
}

// The MSN chat body for a set's pop-out window (rendered inside an xpPopup). The
// comments POST re-renders this into #set-chat-N.
// The compose form must target the msn-chat div BY ITS OWN id, so an outerHTML swap
// replaces it with a div carrying that same id and the next send still has a target.
// (It used to aim at the wrapper, #set-chat-N: the first send replaced the wrapper
// with the inner div, and every send after that resolved to nothing — one message,
// then silence until a reload.)
function setChat(festival, set, comments) {
    return msnChat({
        toLabel: `To: <b>${escapeHtml(set.artist)}</b> &lt;fans@camp&gt;`,
        dpEmoji: '🎵', comments, windowed: true,
        postUrl: `/f/${festival.id}/schedule/set/${set.id}/comments`,
        target: `#set-chat-inner-${set.id}`,
        id: `set-chat-inner-${set.id}`,
    });
}

// The on-card interested list, re-emitted OOB after a toggle so the card face
// reflects it. Always present (empty when none) so the OOB swap has a target.
function setWhoOob(set) {
    return html`<span class="sched-tile-who-inline" id="set-who-${set.id}" hx-swap-oob="true">${whoInline(set)}</span>`;
}

async function loadSetForFest(c) {
    const festival = await loadFestival(c);
    if (!festival) return null;
    const set = await loadSet(c.env.DB, Number(c.req.param('setId')), c.get('person'));
    if (!set || set.festival_id !== festival.id) return null;
    return { festival, set };
}

// Pop out a set's chat as its own draggable MSN window when "Chat" is tapped.
schedule.get('/f/:id/schedule/set/:setId/chat-window', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    const { festival, set } = loaded;
    const comments = await loadComments(c.env.DB, 'set', set.id);
    return c.html(xpPopup({
        title: `${set.artist} — Chat`,
        id: `chat-${set.id}`,
        cls: 'chat-popup',
        body: html`<div id="set-chat-${set.id}">${setChat(festival, set, comments)}</div>`,
    }));
});

// Resolve a set's artist to a Spotify page on first tap. Answers JSON (not a
// fragment) because the caller is waiting to point a tab at the URL — see
// campSpotifyPlay. resolveSpotifyLink reads the cache BEFORE spending any budget or
// calling Spotify, so a tap on an artist someone else looked up since this page
// loaded costs nothing. It runs at most once per artist across every camp; everyone
// after gets the link rendered straight into the card as a plain anchor.
//
// We search the SPLIT name, never the printed one — "DJ DIESEL AKA SHAQ" would
// otherwise find "DIESEL", a different artist. ?artist= lets the b2b picker say
// which half it means, but it's matched against this set's own names: it must never
// become a free-text Spotify search proxy running on our budget.
schedule.get('/f/:id/schedule/set/:setId/spotify', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    const choices = splitArtists(loaded.set.artist);
    if (!choices.length) return c.json({ status: 'none' });
    const wanted = c.req.query('artist');
    const name = choices.find((a) => a === wanted) || choices[0];
    return c.json(await resolveSpotifyLink(c.env, name));
});

// Toggle interest — mirrors the vote toggle (UNIQUE row, soft-delete reused). Swaps
// only the card's actions block (so an open chat below survives) and OOB-updates the
// collapsed head badge.
//
// This is the schedule's hottest tap, so it's built lean: not audited (the Log is
// for destructive actions — edits, deletes — not "I'm going"), and the whole thing
// is three overlapped round trips instead of a dozen queued ones. The single-upsert
// toggle also makes a double-tap race harmless: the old SELECT-then-INSERT could
// have two in-flight taps both INSERT and the loser die on the UNIQUE constraint.
schedule.post('/f/:id/schedule/set/:setId/interest', async (c) => {
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const festivalId = Number(c.req.param('id'));

    // The fest check and the set row don't depend on each other. The set query is
    // scoped to the URL's fest (a set id from another fest 404s) and carries its
    // comment count along, so the re-render below doesn't have to fetch it again.
    const [festival, set] = await Promise.all([
        loadFestival(c),
        db.prepare(`
            SELECT s.*, (SELECT COUNT(*) FROM comments
                         WHERE target_type = 'set' AND target_id = s.id AND deleted_at IS NULL) AS comment_count
            FROM schedule_sets s
            WHERE s.id = ? AND s.festival_id = ? AND s.deleted_at IS NULL
        `).bind(Number(c.req.param('setId')), festivalId).first(),
    ]);
    if (!festival || !set) return c.notFound();

    // One batch (one round trip, statements run in order): flip the row, then read
    // back the live list the card face renders from. Marking interest counts you as
    // going to the fest, so the membership upsert rides along too. The Spotify
    // attach only needs the artist name, so it overlaps the batch.
    const toggle = db.prepare(`
        INSERT INTO set_interests (set_id, person_id) VALUES (?, ?)
        ON CONFLICT(set_id, person_id) DO UPDATE SET
            deleted_at = CASE WHEN deleted_at IS NULL THEN datetime('now') ELSE NULL END
    `).bind(set.id, person.id);
    const freshInterests = db.prepare(`
        SELECT si.person_id, pe.display_name FROM set_interests si
        JOIN people pe ON pe.id = si.person_id
        WHERE si.set_id = ? AND si.deleted_at IS NULL ORDER BY si.created_at
    `).bind(set.id);
    const [[, interestRes]] = await Promise.all([
        db.batch([toggle, freshInterests, membershipStatement(db, festivalId, person.id)]),
        attachSpotifyLinks(db, [set]),
    ]);

    applyInterestRows(set, interestRes.results, person);
    return c.html(html`<div class="sched-tile-actions" id="set-actions-${set.id}">${setActions(festival, set)}</div>${setWhoOob(set)}`);
});

schedule.post('/f/:id/schedule/set/:setId/comments', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const { festival, set } = loaded;
    const person = c.get('person');
    return handleCommentPost(c, {
        festival, targetType: 'set', targetId: set.id,
        ownerPersonId: set.added_by,
        summary: `${person.display_name} commented on ${set.artist}`,
        notifyHeading: `${person.display_name} commented on ${set.artist}`,
        notifyBody: (text) => `${person.display_name} said "${text}" about ${set.artist} at ${festival.name}.`,
        respond: async () => {
            const comments = await loadComments(c.env.DB, 'set', set.id);
            return c.html(html`${setChat(festival, set, comments)}${chatButton(festival, set, comments.length, { oob: true })}`);
        },
    });
});

// Parse the after-midnight-aware time fields into stored minutes; end that lands
// before start is nudged to the next day (a set that crosses midnight).
function readTimes(body) {
    let start = clockToMin((body.start || '').toString(), !!body.start_am);
    let end = clockToMin((body.end || '').toString(), !!body.end_am);
    if (start != null && end != null && end <= start) end += 1440;
    return { start, end };
}

// A stage's column index: reuse an existing stage's order, else next free slot, so
// a hand-added set lands in the right column.
async function stageOrderFor(db, festivalId, stageName) {
    const name = (stageName || '').trim();
    if (name) {
        const ex = await db.prepare("SELECT stage_order FROM schedule_sets WHERE festival_id = ? AND stage = ? AND deleted_at IS NULL ORDER BY stage_order LIMIT 1").bind(festivalId, name).first();
        if (ex) return ex.stage_order;
    }
    const max = await db.prepare('SELECT MAX(stage_order) AS m FROM schedule_sets WHERE festival_id = ? AND deleted_at IS NULL').bind(festivalId).first();
    return (max && max.m != null) ? max.m + 1 : 0;
}

// The edit popup — reached only from edit mode (tap a tile). Buried on purpose.
schedule.get('/f/:id/schedule/set/:setId/edit-window', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const { festival, set } = loaded;
    return c.html(xpPopup({
        title: 'Edit Set', id: `edit-set-${set.id}`,
        body: html`
          <form class="popup-form-car" hx-post="/f/${festival.id}/schedule/set/${set.id}/edit" hx-target="#sched-body" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful && event.detail.elt === this) closePopup(this)">
            ${setFields(set)}
            <div class="edit-field"><label>Spotify:</label>
              <span class="set-spotify-row">
                ${set.spotify_url
                    ? html`<a class="set-spotify-cur" href="${set.spotify_url}" target="_blank" rel="noopener noreferrer">${set.spotify_url.replace('https://open.spotify.com/', '')}</a>`
                    : html`<span class="set-spotify-cur set-spotify-cur-none">${set.spotify_checked ? 'nothing found' : 'not looked up yet'}</span>`}
                <button class="btn" type="button" hx-get="/f/${festival.id}/schedule/set/${set.id}/spotify-window" hx-target="#popup-layer" hx-swap="beforeend">Change Spotify URL…</button>
              </span></div>
            <div class="dialog-buttons">
              <button class="btn btn-primary" type="submit">Save Changes</button>
              <button class="btn btn-danger" type="button"
                hx-post="/f/${festival.id}/schedule/set/${set.id}/delete" hx-target="#sched-body" hx-swap="outerHTML"
                hx-confirm="Are you sure you want to remove ${set.artist} from the schedule?"
                hx-on::after-request="if(event.detail.successful) closePopup(this)">Delete</button>
              <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
            </div>
          </form>`,
    }));
});

// Fix an artist's Spotify link by hand. Reached from the (buried) edit popup,
// because it's a correction, not something you do while browsing.
//
// Worth knowing: the link is keyed by ARTIST and shared by every camp, so fixing it
// fixes it for everyone — which is the point. The search takes the top hit when no
// name matches exactly, and for a small act that can be a bigger, unrelated artist,
// so someone who knows the act needs to be able to say so.
schedule.get('/f/:id/schedule/set/:setId/spotify-window', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const { festival, set } = loaded;
    return c.html(xpPopup({
        title: 'Change Spotify URL', id: `spotify-set-${set.id}`,
        body: html`
          <form class="popup-form-car" hx-post="/f/${festival.id}/schedule/set/${set.id}/spotify-url" hx-target="#sched-body" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)">
            <div class="meet-task-head">
              <img src="/xp/desk-schedule.png" alt="" width="30" height="30">
              <div class="meet-task-text">
                <b>Where should "${set.artist}" play from?</b>
                <span>In Spotify, hit Share → Copy link on the artist (or an album or playlist) and paste it here.</span>
              </div>
            </div>
            <div class="edit-field"><label>Link:</label>
              <input type="text" name="url" value="${set.spotify_url || ''}" placeholder="https://open.spotify.com/artist/..."></div>
            <p class="popup-hint">Leave it empty to forget the link and let it be looked up again next time. This link is shared with every camp that has ${set.artist} on their schedule.</p>
            <div class="dialog-buttons">
              <button class="btn btn-primary" type="submit">Save Link</button>
              <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
            </div>
          </form>`,
    }));
});

schedule.post('/f/:id/schedule/set/:setId/spotify-url', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const { festival, set } = loaded;
    const person = c.get('person');
    const raw = ((await c.req.parseBody()).url || '').toString().trim();
    const url = raw ? parseSpotifyUrl(raw) : null;

    // Typed something that isn't a Spotify link — say so and change nothing, rather
    // than pinning junk that every camp then sees. Re-render #sched-body alongside
    // the warning: this form swaps outerHTML into it, and a response carrying only
    // an out-of-band dialog would leave nothing to swap in and blank the schedule.
    if (raw && !url) {
        return c.html(html`${await scheduleBody(c, festival, set.day || '', { edit: true })}${successDialog({
            icon: 'warning',
            message: html`That doesn't look like a Spotify link. Copy it from Spotify itself (Share → Copy link) — it should start with <b>open.spotify.com</b>.`,
        })}`);
    }

    await setSpotifyLink(c.env.DB, set.artist, url);
    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'schedule_sets', entityId: set.id,
        summary: url
            ? `${person.display_name} set the Spotify link for ${set.artist}`
            : `${person.display_name} cleared the Spotify link for ${set.artist}`,
    });
    return c.html(html`${await scheduleBody(c, festival, set.day || '', { edit: true })}${successDialog({
        icon: 'success',
        message: url
            ? html`<b>${set.artist}</b> now plays from <b>${url.replace('https://open.spotify.com/', '')}</b>.`
            : html`The Spotify link for <b>${set.artist}</b> was cleared. It'll be looked up again next time someone taps Play.`,
    })}`);
});

schedule.post('/f/:id/schedule/set/:setId/edit', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const { festival, set } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const { start, end } = readTimes(body);
    const stage = (body.stage || '').toString().trim() || null;

    const before = { artist: set.artist, stage: set.stage, day: set.day, start_min: set.start_min, end_min: set.end_min, stage_order: set.stage_order };
    const after = {
        artist: (body.artist || '').toString().trim() || set.artist,
        stage,
        day: (body.day || '').toString().trim() || null,
        start_min: start ?? set.start_min,
        end_min: end ?? set.end_min,
        stage_order: stage && stage !== set.stage ? await stageOrderFor(db, festival.id, stage) : set.stage_order,
    };

    await db.prepare('UPDATE schedule_sets SET artist=?, stage=?, day=?, start_min=?, end_min=?, stage_order=? WHERE id=?')
        .bind(after.artist, after.stage, after.day, after.start_min, after.end_min, after.stage_order, set.id).run();
    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'schedule_sets', entityId: set.id,
        before, after, reversible: true, effects: fieldEffects('schedule_sets', set.id, before, after),
        summary: `${person.display_name} edited ${after.artist} on the schedule`,
    });

    // Stay in edit mode so more fixes flow; the popup closes itself on success.
    return c.html(await scheduleBody(c, festival, after.day || '', { edit: true }));
});

schedule.post('/f/:id/schedule/set/:setId/delete', async (c) => {
    const loaded = await loadSetForFest(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const { festival, set } = loaded;
    const db = c.env.DB;
    const person = c.get('person');

    const stamp = sqlNow();
    await db.prepare('UPDATE schedule_sets SET deleted_at = ? WHERE id = ?').bind(stamp, set.id).run();
    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'schedule_sets', entityId: set.id,
        reversible: true, effects: [deleteEffect('schedule_sets', set.id, stamp)],
        summary: `${person.display_name} removed ${set.artist} from the schedule`,
    });
    return c.html(await scheduleBody(c, festival, set.day || '', { edit: true }));
});

// ————————————————————————————— add a set by hand —————————————————————————————————

schedule.get('/f/:id/schedule/add-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    return c.html(xpPopup({
        title: 'Add Set',
        id: `add-set-${festival.id}`,
        body: html`
          <form class="popup-form-car" hx-post="/f/${festival.id}/schedule/sets" hx-target="#sched-body" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful && event.detail.elt === this) closePopup(this)">
            <p class="popup-hint">Add a set the reader missed. It will show up in its stage's column at the time you give.</p>
            ${setFields(null, c.req.query('day') || '')}
            <div class="dialog-buttons">
              <button class="btn btn-primary" type="submit">Add Set</button>
              <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
            </div>
          </form>`,
    }));
});

schedule.post('/f/:id/schedule/sets', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const artist = (body.artist || '').toString().trim();
    if (!artist) return c.html(await scheduleBody(c, festival, (body.day || '').toString()));

    const { start, end } = readTimes(body);
    const stage = (body.stage || '').toString().trim() || null;
    const day = (body.day || '').toString().trim() || null;
    const stageOrder = await stageOrderFor(db, festival.id, stage);

    const res = await db.prepare(`
        INSERT INTO schedule_sets (festival_id, day, stage, stage_order, artist, start_min, end_min, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(festival.id, day, stage, stageOrder, artist, start, end, person.id).run();
    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'schedule_sets', entityId: res.meta.last_row_id,
        reversible: true, effects: [createEffect('schedule_sets', res.meta.last_row_id, sqlNow())],
        summary: `${person.display_name} added ${artist} to the schedule`,
    });
    // Added from the edit banner → stay in edit mode.
    return c.html(await scheduleBody(c, festival, day || '', { edit: true }));
});

// ————————————————————————————— import from an image —————————————————————————————

// How many pictures one import will read. Each is a separate (paid) vision call, and
// they run in parallel, so this bounds both the bill and the wait — a whole festival
// is realistically three or four pictures.
const MAX_IMPORT_IMAGES = 6;

// The upload form (also re-rendered as "Start Over" from the preview/error views).
//
// There is only ONE import: read pictures, save each day's sets, replacing whatever
// that day already had. "Add Saturday" and "re-do Friday" are not two features —
// they're the same operation pointed at a different day, and which one it turns out
// to be is just a consequence of the day. So: one dialog, one button.
//
// There's no day field here on purpose. With several pictures a single day box is
// meaningless ("which picture?"), and a poster nearly always prints its own day —
// so the day is READ, then shown per-day in the preview where it's editable and
// where you can see the sets it belongs to.
function importForm(festival) {
    return html`
      <div class="meet-task-head">
        <img src="/xp/desk-schedule.png" alt="" width="30" height="30">
        <div class="meet-task-text">
          <b>Where is the schedule?</b>
          <span>Choose photos or screenshots of the set times. Windows Media Player will read the artists and times off them for you.</span>
        </div>
      </div>
      <form class="popup-form-car import-form" onsubmit="return campImportSchedule(event, this, '/f/${festival.id}/schedule/import')">
        <div class="edit-field"><label>Pictures:</label><input type="file" name="image" accept="image/*" multiple required></div>
        <p class="popup-hint">One picture per day — pick Friday, Saturday and Sunday all at once and each is read separately. Up to ${MAX_IMPORT_IMAGES}. You get to check them before anything is saved.</p>
        <p class="popup-hint import-wait" id="import-wait">Please wait while the schedule is read. This can take up to a minute…</p>
        <div class="dialog-buttons">
          <button class="btn btn-primary" type="submit">Read Schedule</button>
          <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
        </div>
      </form>`;
}

schedule.get('/f/:id/schedule/import-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    return c.html(xpPopup({
        title: 'Import Schedule', id: `import-${festival.id}`, wide: true,
        body: html`<div id="import-inner">${importForm(festival)}</div>`,
    }));
});

// Just the upload form (inner) — "Start Over" from the preview swaps this back in.
schedule.get('/f/:id/schedule/import-form', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    return c.html(importForm(festival));
});

schedule.post('/f/:id/schedule/import', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;

    // The browser sends data URLs it encoded itself (campImportSchedule), not files:
    // base64-encoding a photo costs ~9ms of CPU and a Worker only gets 10ms on the
    // free plan, so the bytes are never ours to touch. We hand the string straight
    // to the model.
    let images;
    try {
        const body = await c.req.json();
        images = (Array.isArray(body.images) ? body.images : []).filter((s) => typeof s === 'string');
    } catch (e) {
        images = [];
    }

    // On any failure, show the reason then the upload form again so they can retry —
    // all inside #import-inner, so the popup stays put.
    const importError = (msg) => c.html(html`
      <div class="xp-dialog-prompt"><img class="xp-dialog-icon" src="/xp/dlg-warning.png" alt=""><div class="xp-dialog-msg">${msg}</div></div>
      <hr class="popup-divider">
      ${importForm(festival)}`);

    if (!images.length) {
        return importError('No picture was chosen. Please choose a photo or screenshot of the schedule.');
    }
    if (images.length > MAX_IMPORT_IMAGES) {
        return importError(`That's ${images.length} pictures. Please read at most ${MAX_IMPORT_IMAGES} at a time.`);
    }
    // It has to actually be an image the browser encoded — this string goes straight
    // out to the model, so don't forward whatever a client felt like posting.
    if (!images.every((s) => /^data:image\/[a-z.+-]+;base64,/i.test(s))) {
        return importError('That does not look like a picture. Please choose a photo or screenshot of the schedule.');
    }
    // Cap the size the model will accept. base64 inflates ~33%, so this is ~8 MB of
    // actual image — plenty for a legible poster.
    if (images.some((s) => s.length > 11 * 1024 * 1024)) {
        return importError('One of those pictures is too large. Please choose smaller photos or screenshots.');
    }
    if (!c.env.OPENROUTER_API_KEY) {
        return importError('The schedule reader is not configured on this server. You can still add sets by hand, or load a schedule another camp has shared.');
    }

    // One paid vision call per picture, all in flight at once so three days take as
    // long as one rather than three times as long. Each takes its own slice of the
    // monthly budget (D1-backed, shared across isolates) right before it spends it,
    // so a batch can't sneak past the cap — a picture that can't get budget just
    // comes back null and the rest still work.
    const parses = await Promise.all(images.map(async (dataUrl) => {
        if (!await takeApiBudget(db, 'schedule_vision', SCHEDULE_VISION_MONTHLY_LIMIT)) return null;
        try {
            return await parseScheduleImage(c.env.OPENROUTER_API_KEY, dataUrl);
        } catch (e) {
            return null;
        }
    }));

    const groups = mergeParsedByDay(parses);
    if (!groups.length) {
        return importError(images.length > 1
            ? "Windows Media Player couldn't read a schedule from any of those pictures. Try clearer, straight-on photos or screenshots — or add the sets by hand."
            : "Windows Media Player couldn't read a schedule from that picture. Try a clearer, straight-on photo or a screenshot — or add the sets by hand.");
    }
    // Tell them what saving each day will cost, rather than making them declare
    // "add" or "replace" before they've even seen what was read.
    for (const g of groups) {
        const existing = await db.prepare(`
            SELECT COUNT(*) AS n FROM schedule_sets
            WHERE festival_id = ? AND COALESCE(day, '') = ? AND deleted_at IS NULL
        `).bind(festival.id, (g.day || '').trim()).first();
        g.replacing = existing ? existing.n : 0;
    }
    return c.html(importPreview(festival, groups, images.length - parses.filter(Boolean).length));
});

// Two pictures can land on the same day — a poster split across two photos, or one
// picture per stage. Merge them into a single day rather than letting the second
// replace the first, and re-number stage columns across the merged whole (which is
// why the raw sets are merged BEFORE normalizeParsedSets runs, at save time).
// Order follows first appearance, so the days come out in the order you picked them.
function mergeParsedByDay(parses) {
    const byDay = new Map();
    for (const p of parses) {
        if (!p || !p.sets || !p.sets.length) continue;
        const key = (p.day || '').trim();
        if (!byDay.has(key)) byDay.set(key, { day: key, sets: [] });
        byDay.get(key).sets.push(...p.sets);
    }
    return [...byDay.values()];
}

// Read-only review of what the reader found before anything is saved — one section
// per day, each grouped by stage. Corrections to the sets themselves happen on the
// grid afterwards (tap a tile → Edit); the one thing that gets fixed HERE is the day
// name, because it decides which day gets replaced and the reader can't always know
// it (a poster that never prints "SATURDAY" leaves it blank for you to fill in).
//
// `replacing` per day is how many sets that day already has, so the user learns
// whether they're adding a day or overwriting one without being asked up front.
// `unreadable` is how many pictures couldn't be read at all.
function importPreview(festival, groups, unreadable = 0) {
    const total = groups.reduce((n, g) => n + g.sets.length, 0);
    const payload = JSON.stringify(groups.map((g) => ({ day: g.day, sets: g.sets })));
    return html`
      <div class="import-preview">
        <div class="meet-task-head">
          <img src="/xp/dlg-success.png" alt="" width="30" height="30">
          <div class="meet-task-text">
            <b>Found ${total} set${total === 1 ? '' : 's'} across ${groups.length} day${groups.length === 1 ? '' : 's'}.</b>
            <span>Have a look, then save it to your fest. You can fix anything the reader got wrong afterwards — just tap a set on the grid.</span>
          </div>
        </div>
        ${unreadable ? html`<p class="popup-hint import-replacing">${unreadable} picture${unreadable === 1 ? '' : 's'} couldn't be read and ${unreadable === 1 ? 'was' : 'were'} skipped. What's below is everything that could be.</p>` : ''}
        <form hx-post="/f/${festival.id}/schedule/import/save" hx-target="#sched-body" hx-swap="outerHTML"
          hx-on::after-request="if(event.detail.successful) closePopup(this)">
          <input type="hidden" name="payload" value="${payload}">
          ${groups.map((g, i) => html`
            <div class="import-day">
              <div class="import-day-head">
                <label for="import-day-${i}">Day:</label>
                <input type="text" id="import-day-${i}" name="day_${i}" value="${g.day}" placeholder="Friday">
                <span class="import-day-count">${g.sets.length} set${g.sets.length === 1 ? '' : 's'}</span>
              </div>
              ${g.replacing ? html`<p class="popup-hint import-replacing">${g.day || 'This day'} already has <b>${g.replacing}</b> set${g.replacing === 1 ? '' : 's'} — saving replaces ${g.replacing === 1 ? 'it' : 'them'}. Your other days aren't touched, and you can undo it from the Log.</p>` : ''}
              <div class="import-preview-list">
                ${[...groupByStage(g.sets).entries()].map(([stage, sets]) => html`
                  <div class="import-stage">
                    <div class="import-stage-head" style="--stage:${stageColor(stage, sets[0].stage_order || 0)}">${stage || 'Set Times'}</div>
                    ${sets.map((s) => html`<div class="import-row"><span class="import-time">${fmtSetRange(s.start_min, s.end_min)}</span><span class="import-artist">${s.artist}</span></div>`)}
                  </div>`)}
              </div>
            </div>`)}
          <div class="dialog-buttons">
            <button class="btn btn-primary" type="submit">Save to This Fest</button>
            <button class="btn" type="button" hx-get="/f/${festival.id}/schedule/import-form" hx-target="#import-inner" hx-swap="innerHTML">Start Over</button>
          </div>
        </form>
      </div>`;
}

function groupByStage(sets) {
    const byStage = new Map();
    for (const s of sets) {
        if (!byStage.has(s.stage)) byStage.set(s.stage, []);
        byStage.get(s.stage).push(s);
    }
    return byStage;
}

schedule.post('/f/:id/schedule/import/save', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    let groups;
    try { groups = JSON.parse((body.payload || '').toString()); } catch (e) { groups = null; }
    if (!Array.isArray(groups)) groups = [];

    // Re-merge on the day names as EDITED in the preview, not as read: if two days
    // ended up sharing a name, they're one day now, and saving them one after the
    // other would have the second wipe the first (replaceDaySets clears the day
    // first). Merging raw and normalizing once also re-numbers stage columns across
    // the combined day.
    const byDay = new Map();
    groups.forEach((g, i) => {
        const edited = body[`day_${i}`] != null ? body[`day_${i}`] : (g && g.day);
        const day = (edited || '').toString().trim() || null;
        const key = day || '';
        if (!byDay.has(key)) byDay.set(key, { day, sets: [] });
        byDay.get(key).sets.push(...((g && g.sets) || []));
    });

    const stamp = sqlNow();
    const effects = [];
    const saved = [];
    let firstId = null;
    for (const { day, sets: rawSets } of byDay.values()) {
        const sets = normalizeParsedSets(rawSets);
        if (!sets.length) continue;
        const { clearedIds, insertedIds } = await replaceDaySets(db, { festivalId: festival.id, day, sets, personId: person.id, stamp });
        if (!insertedIds.length) continue;
        if (firstId == null) firstId = insertedIds[0];
        effects.push(
            ...clearedIds.map((id) => deleteEffect('schedule_sets', id, stamp)),
            ...insertedIds.map((id) => createEffect('schedule_sets', id, stamp)),
        );
        saved.push({ day, n: insertedIds.length, sets });
    }
    if (!saved.length) return c.html(await scheduleBody(c, festival, c.req.query('day')));

    const total = saved.reduce((n, s) => n + s.n, 0);
    const dayList = saved.map((s) => `${s.day || 'the schedule'} (${s.n})`).join(', ');
    // One audit entry for the whole import, so undo puts back every day at once —
    // it was one action to the person who did it.
    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'schedule_sets', entityId: firstId,
        reversible: true, effects,
        summary: `${person.display_name} imported ${dayList} — ${total} set${total === 1 ? '' : 's'}`,
    });

    return c.html(html`${await scheduleBody(c, festival, saved[0].day || '')}${successDialog({
        message: html`Imported <b>${total}</b> set${total === 1 ? '' : 's'} across ${saved.length} day${saved.length === 1 ? '' : 's'}: ${dayList}. Tap a set to say you're interested or chat. To fix anything the reader got wrong, click <b>Edit Schedule</b>.`,
    })}`);
});

// ————————————————————————— decentralized sharing (publish / adopt) ————————————————

schedule.get('/f/:id/schedule/share-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const existing = await c.env.DB.prepare('SELECT title FROM schedule_publications WHERE source_festival_id = ? AND deleted_at IS NULL').bind(festival.id).first();
    return c.html(xpPopup({
        title: 'Share This Schedule', id: `share-${festival.id}`,
        body: html`
          <form class="popup-form-car" hx-post="/f/${festival.id}/schedule/share" hx-target="#popup-layer" hx-swap="beforeend"
            hx-on::after-request="if(event.detail.successful) closePopup(this)">
            <div class="meet-task-head">
              <img src="/xp/globe.png" alt="" width="30" height="30">
              <div class="meet-task-text">
                <b>Share this schedule with other camps?</b>
                <span>This publishes a copy other fests can load. They get their own editable copy — your schedule and who's interested stay private to you.${existing ? ' Re-sharing updates the copy you already published.' : ''}</span>
              </div>
            </div>
            <div class="edit-field"><label>Name it:</label><input type="text" name="title" value="${existing ? existing.title : festival.name}" placeholder="Elements Music &amp; Arts Festival 2026" required></div>
            <div class="dialog-buttons">
              <button class="btn btn-primary" type="submit">${existing ? 'Update Shared Copy' : 'Publish'}</button>
              <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
            </div>
          </form>`,
    }));
});

schedule.post('/f/:id/schedule/share', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const title = ((await c.req.parseBody()).title || '').toString().trim() || festival.name;

    const pubId = await publishSchedule(db, { festivalId: festival.id, title, personId: person.id });
    if (!pubId) return c.html(successDialog({ icon: 'warning', message: 'There is nothing to share yet — import or add some sets first.' }));

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'schedule_publications', entityId: pubId,
        summary: `${person.display_name} shared the "${title}" schedule for other camps to load`,
    });
    return c.html(successDialog({ icon: 'success', message: html`<b>${title}</b> is now shared. Other camps can load it from their Schedule tab with <b>Load a Shared Schedule</b>.` }));
});

schedule.get('/f/:id/schedule/load-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const pubs = await listPublications(db, festival.id);
    const hasSets = await db.prepare('SELECT 1 FROM schedule_sets WHERE festival_id = ? AND deleted_at IS NULL LIMIT 1').bind(festival.id).first();
    const confirmMsg = hasSets ? 'This will replace your current schedule (you can undo it). Continue?' : '';

    return c.html(xpPopup({
        title: 'Load a Shared Schedule', id: `load-${festival.id}`, wide: true,
        body: html`
          <p class="popup-hint">Load a schedule another camp has published. You get your own editable copy — fix anything, and it won't affect anyone else.</p>
          ${pubs.length ? html`<div class="pick-list">
            ${pubs.map((p) => html`<button class="pick-row" type="button"
                hx-post="/f/${festival.id}/schedule/adopt/${p.id}" hx-target="#sched-body" hx-swap="outerHTML"
                ${confirmMsg ? html`hx-confirm="${confirmMsg}"` : ''}
                hx-on::after-request="if(event.detail.successful) closePopup(this)">
                <img class="pick-ico" src="/xp/desk-schedule.png" alt="">
                <span class="pick-name"><b>${p.title}</b><span class="pick-sub">${p.set_count} sets · from ${p.source_name || 'another camp'}${p.publisher ? ` · shared by ${p.publisher}` : ''}</span></span>
              </button>`)}
          </div>` : html`<p class="pick-empty">No camps have shared a schedule yet. Be the first — import one, then click <b>Share This Schedule</b>.</p>`}
          <div class="dialog-buttons"><button class="btn" type="button" onclick="closePopup(this)">Cancel</button></div>`,
    }));
});

schedule.post('/f/:id/schedule/adopt/:pubId', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const pubId = Number(c.req.param('pubId'));
    const pub = await db.prepare('SELECT title FROM schedule_publications WHERE id = ? AND deleted_at IS NULL').bind(pubId).first();
    if (!pub) return c.notFound();

    const stamp = sqlNow();
    const { clearedIds, insertedIds } = await adoptPublication(db, { festivalId: festival.id, publicationId: pubId, personId: person.id, stamp });
    if (!insertedIds.length) return c.html(await scheduleBody(c, festival, null));

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'schedule_sets', entityId: insertedIds[0],
        reversible: true,
        effects: [...clearedIds.map((id) => deleteEffect('schedule_sets', id, stamp)), ...insertedIds.map((id) => createEffect('schedule_sets', id, stamp))],
        summary: `${person.display_name} loaded the "${pub.title}" schedule (${insertedIds.length} sets)`,
    });
    return c.html(html`${await scheduleBody(c, festival, null)}${successDialog({ message: html`Loaded <b>${pub.title}</b> — ${insertedIds.length} sets. It's your own copy now; tap a set to say you're interested. To change anything, click <b>Edit Schedule</b>.` })}`);
});
