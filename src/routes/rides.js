import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival, ensureMembershipForPerson } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { sqlNow, createEffect, deleteEffect, fieldEffects } from '../lib/effects.js';
import { notify } from '../lib/notify.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { loadComments, handleCommentPost } from '../lib/comments.js';
import { createPlaceholder } from '../lib/people.js';
import { msnChat, escapeHtml } from '../render/msn.js';
import { xpPopup, xpDialogPopup, xpCaptionBtns } from '../render/popup.js';
import { takeApiBudget, PLACES_MONTHLY_LIMIT } from '../lib/budget.js';

export const rides = new Hono();

// The classic XP "operation complete" notice — no icon, just the good news.
function addedDialog(message) {
    return xpDialogPopup({
        title: 'Camp Planner',
        id: 'seat-added',
        message,
        buttons: html`<button class="btn btn-primary" type="button" onclick="closePopup(this)">OK</button>`,
    });
}

async function carStats(db, car) {
    const seats = (await db.prepare(`
        SELECT s.id, s.person_id, pe.display_name FROM seats s
        JOIN people pe ON pe.id = s.person_id
        WHERE s.car_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at
    `).bind(car.id).all()).results;

    const comments = await loadComments(db, 'car', car.id);

    return { seats, comments };
}

function carCard(car, driverName, stats, person, expanded = false, chatOpen = false) {
    const { seats, comments } = stats;
    const seatsUnknown = !!car.seats_unknown;
    const openSeats = car.seats_total - seats.length;
    const myTakenSeat = person && seats.find((s) => s.person_id === person.id);
    // Driver first in the riders list, tagged so it's obvious who's behind the wheel.
    const isDriver = (s) => s.person_id === car.driver_person_id;
    const riders = [...seats].sort((a, b) => isDriver(b) - isDriver(a));

    return html`
    <details class="card car-details" id="car-${car.id}" ${expanded ? 'open' : ''}>
      <summary class="item-summary">
        <div class="item-top-row">
          <span class="item-emoji">🚗</span>
          <div class="item-headline">
            <div class="item-name">${driverName}'s car</div>
            <div class="item-description">leaving from ${car.leaving_from || 'idk'} on ${car.depart_day || '?'} ${car.depart_time || ''}</div>
            ${car.description ? html`<div class="item-description car-note">“${car.description}”</div>` : ''}
            <div class="item-description car-headcount">
              <span class="rider-badge">👥 ${seats.length} aboard</span>
              ${seatsUnknown
                  ? html`<span class="seats-unknown">seats: idk</span>`
                  : openSeats > 0
                      ? html`<span class="seats-open">${openSeats} seat${openSeats === 1 ? '' : 's'} open</span>`
                      : html`<span class="seats-full">car full</span>`}
            </div>
          </div>
        </div>
      </summary>

      <div class="item-actions">
        ${seats.length ? html`
          <div class="car-select-bar" hidden>
            <span class="car-select-hint"></span>
            <button class="btn btn-primary car-select-go" type="button" disabled onclick="campCarConfirmRemove(this)">Remove Selected</button>
            <button class="btn" type="button" onclick="campCarSelCancel(this)">Cancel</button>
          </div>` : ''}
        <div class="xp-listview car-roster">
          <div class="xp-listview-head">
            <span class="lv-head-title">Passengers <span class="roster-count">(${seats.length})</span></span>
            <span class="lv-head-actions">
              <button type="button" class="lv-link" hx-get="/cars/${car.id}/add-window" hx-target="#popup-layer" hx-swap="beforeend">Add</button>
              ${seats.length ? html`<button type="button" class="lv-link" onclick="campCarSelect(this)">Remove</button>` : ''}
            </span>
          </div>
          ${riders.length ? riders.map((s) => html`
            <div class="roster-row">
              <label class="car-select-box"><input type="checkbox" class="car-select-check" value="${s.id}" data-name="${s.display_name}"></label>
              <span class="roster-emoji">${isDriver(s) ? '🧑‍✈️' : '🙂'}</span>
              <span class="roster-name">${s.display_name}${isDriver(s) ? html`<span class="driver-badge">driver</span>` : ''}</span>
            </div>`) : html`<div class="roster-empty">empty — even the driver bailed</div>`}
        </div>

        <div class="action-buttons">
          ${!myTakenSeat ? html`
            <form class="car-seat-form" hx-post="/cars/${car.id}/seats/claim" hx-target="#car-${car.id}" hx-swap="outerHTML" hx-vals='js:{chat_open: document.getElementById("chat-car-${car.id}")?.open ? 1 : 0}'>
              <button class="btn btn-primary" type="submit">Join Car</button>
            </form>` : (person && person.id === car.driver_person_id ? html`
            <form class="car-seat-form" hx-get="/cars/${car.id}/leave-window" hx-target="#popup-layer" hx-swap="beforeend">
              <button class="btn" type="submit">Leave Car (you're driving)</button>
            </form>` : html`
            <form class="car-seat-form" hx-post="/seats/${myTakenSeat.id}/leave" hx-target="#car-${car.id}" hx-swap="outerHTML" hx-vals='js:{chat_open: document.getElementById("chat-car-${car.id}")?.open ? 1 : 0}'>
              <button class="btn" type="submit">Leave Car</button>
            </form>`)}

          <input type="checkbox" class="edit-toggle-checkbox" id="edit-toggle-car-${car.id}">
          <label class="btn edit-open-btn" for="edit-toggle-car-${car.id}" onclick="campCarSelCancel(this)">Edit</label>
          <button class="btn btn-primary edit-save-btn" type="submit" form="edit-form-car-${car.id}">Save</button>
            <form id="edit-form-car-${car.id}" class="edit-panel" hx-post="/cars/${car.id}/edit" hx-target="#car-${car.id}" hx-swap="outerHTML" hx-vals='js:{chat_open: document.getElementById("chat-car-${car.id}")?.open ? 1 : 0}'>
              <div class="edit-panel-title">Edit Car</div>
              <div class="edit-field"><label>seats</label>
                <div class="seats-input">
                  <input type="number" name="seats_total" value="${car.seats_total}" min="1" ${seatsUnknown ? 'disabled' : ''}>
                  <label class="seats-unknown-toggle"><input type="checkbox" name="seats_unknown" ${seatsUnknown ? 'checked' : ''} onchange="campSeatsUnknown(this)"> idk yet</label>
                </div>
              </div>
              <div class="edit-field"><label>from</label><input type="text" name="leaving_from" value="${car.leaving_from || ''}" placeholder="Redmond, WA"></div>
              <div class="edit-field"><label>details</label><input type="text" name="description" value="${car.description || ''}" placeholder="e.g. not confirmed yet"></div>
              <div class="edit-field"><label>day</label><input type="text" name="depart_day" value="${car.depart_day || ''}" placeholder="Thu"></div>
              <div class="edit-field"><label>time</label><input type="text" name="depart_time" value="${car.depart_time || ''}" placeholder="9:00 AM"></div>
              <div class="edit-panel-buttons">
                <button class="btn btn-danger" type="submit" formaction="/cars/${car.id}/delete" hx-post="/cars/${car.id}/delete" hx-confirm="Are you sure you want to delete this car?">Delete</button>
              </div>
            </form>

          ${msnChat({
              title: `Chat (${comments.length} message${comments.length === 1 ? '' : 's'})`,
              dpEmoji: '🚗',
              toLabel: `To: <b>${escapeHtml(driverName)}'s car</b> &lt;riders@camp&gt;`,
              comments,
              postUrl: `/cars/${car.id}/comments`,
              target: `#car-${car.id}`,
              chatOpen,
              id: `chat-car-${car.id}`,
          })}
        </div>
      </div>
    </details>`;
}

// The meeting spot lives in a fake copy of Microsoft Streets & Trips — the XP-era
// route planner everyone had a burned CD of — docked above the car list. The window
// chrome (min/max/close, menu bar, status bar) is real-looking but inert; only the
// "Edit" menu works, opening the set-meeting-spot popup. No spot set = the program
// sits there with an empty route, which is exactly how Streets & Trips greeted you.
// Pull the destination lat/lon out of a pasted Google Maps URL so the map pane can
// show a REAL map. Prefer the place's own !3d…!4d… pair (the pin itself — the last
// pair in the URL is the destination) over @lat,lng, which is just the viewport
// center: wherever they happened to be scrolled, not where the place is.
function mapsCoords(url) {
    if (!url) return null;
    const pin = [...url.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)].pop();
    if (pin) return { lat: Number(pin[1]), lon: Number(pin[2]) };
    // Our own breadcrumb: links built by the place-search picker end in #lat,lon
    // (URL fragments never reach Google — they only feed the map pane here).
    const frag = url.match(/#(-?\d+\.\d+),(-?\d+\.\d+)$/);
    if (frag) return { lat: Number(frag[1]), lon: Number(frag[2]) };
    const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) return { lat: Number(at[1]), lon: Number(at[2]) };
    return null;
}

// Follow a maps.app.goo.gl / goo.gl / g.co share link to the full Google Maps URL
// it redirects to — that's where the place name and coordinates live. No API key:
// it's just an HTTP redirect. Non-short links come back untouched.
async function expandMapsUrl(url) {
    if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co)\//i.test(url)) return url;
    try {
        const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined;
        const resp = await fetch(url, { redirect: 'follow', signal });
        return resp.url || url;
    } catch {
        return url;
    }
}

// The place name is right in the URL path — /maps/place/Sunoco/@41.07… — so no API
// is needed for it. Address-only pins put the address in that segment instead
// ("1+Commercial+Blvd,+…"): starts with a house number, has commas.
function parsePlaceName(url) {
    const m = url.match(/\/maps\/place\/([^/@]+)/);
    if (!m) return null;
    let s = m[1].replace(/\+/g, ' ');
    try { s = decodeURIComponent(s); } catch { /* keep the raw segment */ }
    return s.trim() || null;
}

function looksLikeAddress(s) {
    return /^\d/.test(s) && s.includes(',');
}

// The address must be EXACT — never inferred from coordinates, or someone drives
// to the wrong place. Source #1 (free, no API): Google bakes its own address
// string for the pin into most full place URLs as a !2s… token
// ("!2s1+Commercial+Blvd,+Blakeslee,+PA+18610"). We just lift it back out.
function urlAddressToken(url) {
    for (const m of url.matchAll(/!2s([^!]+)/g)) {
        let s = m[1].replace(/\+/g, ' ');
        try { s = decodeURIComponent(s); } catch { /* keep the raw token */ }
        s = s.trim();
        if (looksLikeAddress(s)) return s;
    }
    return null;
}

// Source #2: Google Places API Text Search (New), biased to the pin's coordinates —
// Google's own formattedAddress for the place, same string Maps shows. Needs the
// GOOGLE_MAPS_API_KEY secret (free tier covers thousands of calls/month; we make a
// few per fest). No key configured → returns null and we simply leave the field
// blank rather than guess.
async function googlePlaceAddress(c, name, coords) {
    const env = c.env;
    if (!env.GOOGLE_MAPS_API_KEY || !name) return null;
    if (!await takeApiBudget(env.DB, 'places', PLACES_MONTHLY_LIMIT)) return null;
    try {
        const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined;
        const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'places.formattedAddress',
            },
            body: JSON.stringify({
                textQuery: name,
                pageSize: 1,
                ...(coords ? { locationBias: { circle: { center: { latitude: coords.lat, longitude: coords.lon }, radius: 500 } } } : {}),
            }),
            signal,
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const addr = data.places && data.places[0] && data.places[0].formattedAddress;
        // Everyone here knows which country the fest is in.
        return addr ? addr.replace(/, (USA|United States)$/, '') : null;
    } catch {
        return null;
    }
}

// Everything we can learn about a place from an (already-expanded) maps URL:
// name from the /place/ path segment; address from the URL's own !2s token, else
// Google Places. Exact or nothing — no reverse-geocode approximations.
async function placeFromMapsUrl(c, url) {
    let name = null;
    let address = null;
    const parsed = parsePlaceName(url);
    if (parsed) {
        if (looksLikeAddress(parsed)) address = parsed;
        else name = parsed;
    }
    if (!address) address = urlAddressToken(url);
    if (!address) address = await googlePlaceAddress(c, name, mapsCoords(url));
    return { name, address };
}

// The viewer's own departure point for the "1: Depart from …" leg: whatever
// "leaving from" says on the car they're riding in (latest seat wins, cars without
// one skipped). Not in a car — or the car doesn't say — falls back to "home".
async function viewerDepartFrom(db, festivalId, person) {
    if (!person) return null;
    const row = await db.prepare(`
        SELECT c.leaving_from FROM seats s
        JOIN cars c ON c.id = s.car_id
        WHERE c.festival_id = ? AND s.person_id = ?
          AND s.deleted_at IS NULL AND c.deleted_at IS NULL
          AND c.leaving_from IS NOT NULL AND c.leaving_from != ''
        ORDER BY s.created_at DESC LIMIT 1
    `).bind(festivalId, person.id).first();
    return row ? row.leaving_from : null;
}

function meetBanner(festival, departFrom = null) {
    const hasSpot = !!(festival.meet_name || festival.meet_address || festival.meet_time || festival.meet_maps_url);
    const coords = mapsCoords(festival.meet_maps_url);
    // A real OpenStreetMap embed with a marker on the spot — no API key, no build
    // step, and it even looks period-correct framed in Luna chrome. The bbox is a
    // ~0.012°×0.008° window around the pin: comfortable neighborhood zoom.
    const osmSrc = coords
        ? `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lon - 0.006}%2C${coords.lat - 0.004}%2C${coords.lon + 0.006}%2C${coords.lat + 0.004}&layer=mapnik&marker=${coords.lat}%2C${coords.lon}`
        : '';
    const menu = (label) => label === 'Edit'
        ? html`<button type="button" class="st-menu st-menu-live"
            hx-get="/f/${festival.id}/meet-window" hx-target="#popup-layer" hx-swap="beforeend">Edit</button>`
        : html`<span class="st-menu" aria-hidden="true">${label}</span>`;

    return html`
    <div class="st-window" id="meet-banner">
      <div class="st-titlebar">
        <img class="st-title-ico" src="/xp/globe.png" alt="">
        <span class="st-title">Meetup Spot - ${festival.name}</span>
        ${xpCaptionBtns()}
      </div>
      <div class="st-menubar">${['File', 'Edit', 'View', 'Data', 'Route', 'Tools', 'Help'].map(menu)}</div>
      <div class="st-toolbar">
        <span class="st-tbtn" aria-hidden="true"><img class="st-ticon" src="/xp/back.png" alt="">Back</span>
        <span class="st-tbtn" aria-hidden="true"><img class="st-ticon" src="/xp/forward.png" alt=""></span>
        <span class="st-tsep"></span>
        <button type="button" class="st-tbtn st-tbtn-live"
          hx-get="/f/${festival.id}/meet-window" hx-target="#popup-layer" hx-swap="beforeend">
          <img class="st-ticon" src="/xp/search.png" alt="">Edit Meeting Spot</button>
        <span class="st-tsep"></span>
        <span class="st-tbtn" aria-hidden="true"><img class="st-ticon" src="/xp/printer.png" alt="">Print</span>
      </div>
      <div class="st-body">
        <div class="st-panes">
          <div class="st-dir">
            <div class="st-dir-head">Directions</div>
            ${hasSpot ? html`
              <div class="st-leg"><span class="st-leg-num">1</span><span class="st-leg-main">Depart from ${departFrom || 'home'}</span></div>
              <div class="st-leg"><span class="st-leg-num">2</span><span class="st-leg-main"><b>Arrive at ${festival.meet_name || 'the meeting spot'}</b>${festival.meet_address ? html`<span class="st-addr">${festival.meet_address}</span>` : ''}</span></div>
              ${festival.meet_time ? html`
              <div class="st-leg"><img class="st-ico" src="/xp/cp-datetime.png" alt=""><span class="st-leg-main">Arrive by <b>${festival.meet_time}</b></span></div>` : ''}
              ${festival.meet_maps_url ? html`
              <div class="st-leg"><img class="st-ico" src="/xp/ie.png" alt=""><span class="st-leg-main"><a class="st-link" href="${festival.meet_maps_url}" target="_blank" rel="noopener">Get Directions in Google Maps</a></span></div>` : ''}
            ` : html`
              <div class="st-leg st-leg-empty">There are no directions to display.</div>
              <div class="st-leg"><img class="st-ico" src="/xp/search.png" alt=""><button type="button" class="lv-link"
                hx-get="/f/${festival.id}/meet-window" hx-target="#popup-layer" hx-swap="beforeend">Set Meeting Spot…</button></div>
            `}
          </div>
          <div class="st-map">
            ${osmSrc
                ? html`<iframe class="st-map-frame" src="${osmSrc}" title="Map of the meeting spot" loading="lazy"></iframe>`
                : html`<div class="st-map-empty">
                    <img src="/xp/globe.png" alt="" width="38" height="38">
                    ${hasSpot
                        ? html`<span><b>There is no map of ${festival.meet_name || 'the meeting spot'} to display.</b><br>
                            To show one here, click <b>Edit</b> on the menu bar and paste a link from Google&nbsp;Maps.</span>`
                        : html`<span><b>Where should everyone meet up before rolling in?</b><br>
                            To choose a meeting spot for ${festival.name}, click <b>Edit&nbsp;Meeting&nbsp;Spot</b> on the toolbar, or click the link below.</span>
                          <button type="button" class="lv-link"
                            hx-get="/f/${festival.id}/meet-window" hx-target="#popup-layer" hx-swap="beforeend">Set Meeting Spot…</button>`}
                  </div>`}
          </div>
        </div>
        <div class="st-statusbar" aria-hidden="true">
          <span class="st-status-cell st-status-stops">${hasSpot ? '1 stop' : '0 stops'}</span>
          <span class="st-status-cell">${hasSpot ? 'Route calculated' : 'Ready'}</span>
          <span class="st-status-cell st-status-main"></span>
          ${coords ? html`<span class="st-status-cell st-status-coords">${Math.abs(coords.lat).toFixed(4)}° ${coords.lat >= 0 ? 'N' : 'S'}, ${Math.abs(coords.lon).toFixed(4)}° ${coords.lon >= 0 ? 'E' : 'W'}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// Just the car cards — what #car-list contains, and the only thing endpoints
// targeting #car-list should return (mirrors items.js's itemListFragment).
async function carListFragment(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    const expand = c.req.query('expand') || '';

    const cars = (await db.prepare(`
        SELECT c.*, pe.display_name FROM cars c
        JOIN people pe ON pe.id = c.driver_person_id
        WHERE c.festival_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at
    `).bind(festival.id).all()).results;

    return html`
      ${cars.length === 0 ? html`<p class="stuff-empty">There are no cars in this view — post the first one!</p>` : ''}
      ${await Promise.all(cars.map(async (car) => carCard(car, car.display_name, await carStats(db, car), person, expand === `car-${car.id}`, expand === `car-${car.id}`)))}
    `;
}

async function renderRidesBody(c, festival) {
    return html`
    <div class="post-car-bar">
      <button type="button" class="btn btn-primary post-car-btn"
        hx-get="/f/${festival.id}/cars/post-window" hx-target="#popup-layer" hx-swap="beforeend">
        Post a Car…
      </button>
    </div>

    <div id="car-list">
      ${await carListFragment(c, festival)}
    </div>
  `;
}

rides.get('/f/:id/rides', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderRidesBody(c, festival);
    // Streets & Trips renders as its own window ABOVE the Car Pool window (via
    // `pre`), not nested inside it — two programs open on the desktop.
    const from = await viewerDepartFrom(c.env.DB, festival.id, c.get('person'));
    return c.html(await renderPage(c, { title: `${festival.name} — Cars`, festival, activeTab: 'rides', body, pre: meetBanner(festival, from) }));
});

// The place/address/time rows of the meeting-spot form. A fragment because the
// live maps-link lookup below re-renders exactly this block with what it learned.
function meetFields({ meet_name, meet_address, meet_time }) {
    return html`
      <div id="meet-fields">
        <div class="edit-field"><label>Place:</label><input type="text" name="meet_name" value="${meet_name || ''}" placeholder="Sunoco"></div>
        <div class="edit-field"><label>Address:</label><input type="text" name="meet_address" value="${meet_address || ''}" placeholder="One Microsoft Way, Redmond, WA"></div>
        <div class="edit-field"><label>Time:</label><input type="text" name="meet_time" value="${meet_time || ''}" placeholder="Friday 10:00 AM"></div>
      </div>`;
}

// The Streets & Trips "Edit" menu → set/change the meeting spot for this fest.
rides.get('/f/:id/meet-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);

    return c.html(xpPopup({
        title: 'Set Meeting Spot',
        id: `meet-${festival.id}`,
        wide: true,
        body: html`
          <form class="popup-form-car meet-form" hx-post="/f/${festival.id}/meet" hx-target="#meet-banner" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful && event.detail.elt === this) closePopup(this);">
            <div class="meet-task-head">
              <img src="/xp/search.png" alt="" width="30" height="30">
              <div class="meet-task-text">
                <b>Where is everyone meeting up?</b>
                <span>Search for the place, or paste a link from Google Maps, and the details and map will be filled in for you automatically.</span>
              </div>
            </div>
            <fieldset>
              <legend><img class="cp-legend-ico" src="/xp/globe.png" alt="">Find the place</legend>
              <div class="edit-field"><label>Search for:</label>
                <input type="text" name="q" placeholder="Sunoco in Blakeslee PA" autocomplete="off" data-1p-ignore data-lpignore="true"
                  hx-get="/f/${festival.id}/meet/search" hx-trigger="input changed delay:500ms" hx-target="#meet-search-results"
                  hx-swap="innerHTML" hx-indicator="#meet-wait">
              </div>
              <div id="meet-search-results"></div>
              <div class="edit-field"><label>Maps link:</label>
                <input type="text" name="meet_maps_url" value="${festival.meet_maps_url || ''}" placeholder="https://maps.app.goo.gl/…"
                  hx-get="/f/${festival.id}/meet/lookup" hx-trigger="input changed delay:600ms" hx-target="#meet-fields"
                  hx-swap="outerHTML" hx-include="closest form" hx-indicator="#meet-wait">
              </div>
              <p class="popup-hint htmx-indicator meet-wait" id="meet-wait">Please wait while the place is located…</p>
            </fieldset>
            <fieldset>
              <legend><img class="cp-legend-ico" src="/xp/fav-star.png" alt="">Meeting spot details</legend>
              ${meetFields(festival)}
              <p class="popup-hint meet-omit-hint">To leave a detail off the route, leave its box blank.</p>
            </fieldset>
            <div class="dialog-buttons">
              <button class="btn btn-primary" type="submit">OK</button>
              <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
            </div>
          </form>`,
    }));
});

// Live autofill for the popup: fires as soon as a maps link lands in the field,
// expands short links, and re-renders the place/address/time rows with what the
// link revealed. Freshly parsed info WINS here (you just pasted a new link, you
// want it to take over); the save path below is the polite opposite — it only
// fills fields you left blank.
rides.get('/f/:id/meet/lookup', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    // Signed-in only: this endpoint can trigger outbound (budgeted) API calls.
    if (needsSignin(c)) return signinModalResponse(c);
    const q = c.req.query();
    const fields = {
        meet_name: (q.meet_name || '').trim(),
        meet_address: (q.meet_address || '').trim(),
        meet_time: (q.meet_time || '').trim(),
    };
    let url = (q.meet_maps_url || '').trim();
    if (url) {
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        url = await expandMapsUrl(url);
        const place = await placeFromMapsUrl(c, url);
        fields.meet_name = place.name || fields.meet_name;
        fields.meet_address = place.address || fields.meet_address;
    }
    return c.html(meetFields(fields));
});

// Live place search: type "Sunoco in Blakeslee PA" into the popup's search box and
// Google Places results appear as a click-to-pick list. Each row carries the exact
// name / address / maps link in data- attributes; campMeetPick() (camp.js) copies
// them into the form — no extra roundtrip. Keyless installs get told what's
// missing instead of a silent dead search box.
rides.get('/f/:id/meet/search', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    // Signed-in campers only — anonymous traffic never reaches the paid-tier API.
    if (needsSignin(c)) return signinModalResponse(c);
    // Cheap guards before any quota is spent: 3+ chars (one keystroke isn't a
    // search) and a sane ceiling so nobody ships us a novel.
    const q = (c.req.query('q') || '').trim().slice(0, 120);
    if (q.length < 3) return c.html('');
    if (!c.env.GOOGLE_MAPS_API_KEY) {
        return c.html(html`<p class="pick-empty">Search cannot look up places because a Google Maps key is not configured. Paste a Google Maps link instead.</p>`);
    }
    // Hard monthly budget (D1-backed, shared across isolates): once spent, search
    // degrades for the rest of the month but link-pasting keeps working — parsing
    // a link costs nothing.
    if (!await takeApiBudget(c.env.DB, 'places', PLACES_MONTHLY_LIMIT)) {
        return c.html(html`<p class="pick-empty">Search has reached its limit for this month. Paste a Google Maps link instead — that always works.</p>`);
    }

    let places = [];
    let throttled = false;
    try {
        const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined;
        const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': c.env.GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
            },
            body: JSON.stringify({ textQuery: q, pageSize: 5 }),
            signal,
        });
        if (resp.ok) places = (await resp.json()).places || [];
        // The Google-side burst backstop (30/min quota) trips as a 429 — tell the
        // truth ("busy, wait a minute") instead of pretending nothing matched.
        else if (resp.status === 429) throttled = true;
    } catch { /* fall through to the empty message */ }

    if (throttled) return c.html(html`<p class="pick-empty">Search is busy right now. Please wait a minute and try again, or paste a Google Maps link.</p>`);
    if (!places.length) return c.html(html`<p class="pick-empty">There are no places matching your search.</p>`);
    return c.html(html`<div class="pick-list">
      ${places.map((p) => {
          const name = (p.displayName && p.displayName.text) || '';
          const address = (p.formattedAddress || '').replace(/, (USA|United States)$/, '');
          const lat = p.location && p.location.latitude;
          const lon = p.location && p.location.longitude;
          // query_place_id pins the directions link to THE place (no ambiguity);
          // the #lat,lon fragment is our map-pane breadcrumb (see mapsCoords).
          const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, address].filter(Boolean).join(' '))}`
              + (p.id ? `&query_place_id=${p.id}` : '')
              + (lat != null && lon != null ? `#${lat},${lon}` : '');
          return html`<button class="pick-row" type="button" onclick="campMeetPick(this)"
              data-name="${name}" data-address="${address}" data-url="${url}">
              <img class="pick-ico" src="/xp/fav-star.png" alt="">
              <span class="pick-name"><b>${name}</b><span class="pick-sub">${address}</span></span>
            </button>`;
      })}
    </div>`);
});

rides.post('/f/:id/meet', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    // A pasted maps link without a scheme still needs to be a real link (a bare
    // "maps.google.com/…" href would resolve relative to camp.cuuush.com) — and
    // requiring http(s) here also keeps javascript: out of the banner.
    let mapsUrl = (body.meet_maps_url || '').toString().trim();
    if (mapsUrl && !/^https?:\/\//i.test(mapsUrl)) mapsUrl = `https://${mapsUrl}`;
    // Stored expanded so the map/coords work even when a short link was pasted.
    if (mapsUrl) mapsUrl = await expandMapsUrl(mapsUrl);

    let name = (body.meet_name || '').toString().trim();
    let address = (body.meet_address || '').toString().trim();
    // Paste-and-OK-before-the-lookup-fires: fill missing fields from the link.
    // Only on a CHANGED link — "leave a field blank to omit it" must keep working
    // when the link is the same one that's already stored.
    if (mapsUrl && mapsUrl !== festival.meet_maps_url && (!name || !address)) {
        const place = await placeFromMapsUrl(c, mapsUrl);
        name = name || place.name || '';
        address = address || place.address || '';
    }

    const before = { meet_name: festival.meet_name, meet_address: festival.meet_address, meet_maps_url: festival.meet_maps_url, meet_time: festival.meet_time };
    const after = {
        meet_name: name || null,
        meet_address: address || null,
        meet_maps_url: mapsUrl || null,
        meet_time: (body.meet_time || '').toString().trim() || null,
    };

    // Opening Edit and pressing OK without touching anything is not an update:
    // no write, no audit entry, no ticker noise — just hand back the banner so
    // the swap is invisible and the popup closes.
    const changed = Object.keys(after).some((k) => (after[k] ?? null) !== (before[k] ?? null));
    if (changed) {
        await db.prepare('UPDATE festivals SET meet_name=?, meet_address=?, meet_maps_url=?, meet_time=? WHERE id=?')
            .bind(after.meet_name, after.meet_address, after.meet_maps_url, after.meet_time, festival.id).run();

        const hadSpot = !!(before.meet_name || before.meet_address || before.meet_time || before.meet_maps_url);
        const hasSpot = !!(after.meet_name || after.meet_address || after.meet_time || after.meet_maps_url);
        await logAction(c, {
            festivalId: festival.id, action: 'update', entityType: 'festivals', entityId: festival.id,
            before, after, reversible: true, effects: fieldEffects('festivals', festival.id, before, after),
            summary: !hasSpot
                ? `${person.display_name} cleared the meeting spot`
                : `${person.display_name} ${hadSpot ? 'updated' : 'set'} the meeting spot${after.meet_name ? ` (${after.meet_name})` : ''}`,
        });
    }

    const from = await viewerDepartFrom(db, festival.id, person);
    return c.html(meetBanner({ ...festival, ...after }, from));
});

// The "post a car" form now lives in a real draggable XP window (dropped into
// #popup-layer) instead of an inline dropdown. Same form, same POST target — it
// just closes itself on success and the car list swaps underneath.
rides.get('/f/:id/cars/post-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');

    const members = person ? (await db.prepare(`
        SELECT pe.id, pe.display_name FROM memberships m
        JOIN people pe ON pe.id = m.person_id
        WHERE m.festival_id = ? AND m.bailed_at IS NULL
        ORDER BY pe.id = ? DESC, pe.display_name
    `).bind(festival.id, person.id).all()).results : [];

    return c.html(xpPopup({
        title: 'Post a Car',
        id: `post-car-${festival.id}`,
        body: html`
          <form class="popup-form-car" hx-post="/f/${festival.id}/cars" hx-target="#car-list" hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this);">
            <p class="popup-hint">You're the driver by default, and get the first seat reserved automatically — pick someone else below if you're posting on their behalf.</p>
            <div class="edit-field"><label>driver</label>
              <select name="driver_person_id" onchange="campDriverPick(this)">
                ${members.map((m) => html`<option value="${m.id}" ${person && m.id === person.id ? 'selected' : ''}>${m.id === person?.id ? `${m.display_name} (you)` : m.display_name}</option>`)}
                <option value="__new__">Someone new…</option>
              </select>
            </div>
            <div class="edit-field new-driver-row" hidden><label>name</label>
              <input type="text" name="new_driver_name" placeholder="Type their name" autocomplete="off" data-1p-ignore data-lpignore="true">
            </div>
            <div class="edit-field"><label>seats</label>
              <div class="seats-input">
                <input type="number" name="seats_total" value="4" min="1" title="total seats, including yours">
                <label class="seats-unknown-toggle"><input type="checkbox" name="seats_unknown" onchange="campSeatsUnknown(this)"> idk yet</label>
              </div>
            </div>
            <div class="edit-field"><label>from</label><input type="text" name="leaving_from" placeholder="Redmond, WA"></div>
            <div class="edit-field"><label>details</label><input type="text" name="description" placeholder="e.g. not confirmed yet"></div>
            <div class="edit-field"><label>day</label><input type="text" name="depart_day" placeholder="Thu"></div>
            <div class="edit-field"><label>time</label><input type="text" name="depart_time" placeholder="9:00 AM"></div>
            <div class="dialog-buttons">
              <button class="btn btn-primary" type="submit">Post Car</button>
              <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>
            </div>
          </form>`,
    }));
});

rides.post('/f/:id/cars', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    // Default the driver to whoever's posting, but allow picking a fellow member
    // to post on their behalf (must already belong to this festival) — or, if they
    // chose "someone who hasn't signed up", mint a placeholder person on the spot
    // and make them the driver. That's the case we care about here: a maybe-driver
    // who hasn't logged in yet, tracked so they can claim/update the car later.
    let driverId = person.id;
    let newDriver = null;
    if (body.driver_person_id === '__new__') {
        const name = (body.new_driver_name || '').toString().trim();
        if (name) {
            newDriver = await createPlaceholder(c, festival.id, name); // creates + joins fest
            driverId = newDriver.id;
        }
    } else {
        const requestedDriverId = Number(body.driver_person_id);
        if (requestedDriverId && requestedDriverId !== person.id) {
            const member = await db.prepare(`
                SELECT 1 FROM memberships WHERE festival_id = ? AND person_id = ? AND bailed_at IS NULL
            `).bind(festival.id, requestedDriverId).first();
            if (member) driverId = requestedDriverId;
        }
    }
    const driverPerson = driverId === person.id ? person
        : (newDriver || await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(driverId).first());

    // Record the just-created placeholder as its own audit entry (same shape the
    // "add someone new to a car" flow logs), so the new person shows up in the log.
    if (newDriver) {
        await logAction(c, {
            festivalId: festival.id, action: 'create', entityType: 'people', entityId: newDriver.id,
            summary: `${person.display_name} added ${newDriver.display_name} (not signed up yet)`,
        });
    }

    const seatsUnknown = body.seats_unknown ? 1 : 0;
    const result = await db.prepare(`
        INSERT INTO cars (festival_id, driver_person_id, seats_total, seats_unknown, leaving_from, description, depart_day, depart_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        festival.id, driverId,
        Math.max(1, Number(body.seats_total) || 1),
        seatsUnknown,
        (body.leaving_from || '').toString().trim() || null,
        (body.description || '').toString().trim() || null,
        (body.depart_day || '').toString() || null,
        (body.depart_time || '').toString() || null,
    ).run();

    const carId = result.meta.last_row_id;
    // The driver rides in their own car — seat them right away so the riders
    // list starts with them instead of looking empty.
    const seatResult = await db.prepare('INSERT INTO seats (car_id, person_id) VALUES (?, ?)')
        .bind(carId, driverId).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'cars', entityId: carId,
        reversible: true,
        // Posting a car creates two rows (the car AND the driver's seat); undo hides
        // both so it comes apart exactly as it went in.
        effects: [createEffect('cars', carId, sqlNow()), createEffect('seats', seatResult.meta.last_row_id, sqlNow())],
        summary: (() => {
            const seatText = seatsUnknown ? 'seats TBD' : `${body.seats_total || 1} seats`;
            return driverId === person.id
                ? `${person.display_name} posted a car (${seatText})`
                : `${person.display_name} posted a car for ${driverPerson.display_name} (${seatText})`;
        })(),
    });

    // The post-car form targets #car-list (innerHTML), so return only the list
    // contents — returning the whole rides body here used to nest a second
    // post-car bar and #car-list inside the first.
    return c.html(await carListFragment(c, festival));
});

async function loadCar(c) {
    const id = Number(c.req.param('carId'));
    const db = c.env.DB;
    const car = await db.prepare('SELECT * FROM cars WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    if (!car) return null;
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(car.festival_id).first();
    const driver = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(car.driver_person_id).first();
    return { car, festival, driver };
}

async function carResponse(c, festival, carId, expanded = true, chatOpen = false, dialog = '') {
    const db = c.env.DB;
    const person = c.get('person');
    const car = await db.prepare('SELECT * FROM cars WHERE id = ?').bind(carId).first();
    if (!car || car.deleted_at) return c.html('');
    const driver = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(car.driver_person_id).first();
    const card = carCard(car, driver.display_name, await carStats(db, car), person, expanded, chatOpen);
    if (!dialog) return c.html(card);
    return c.html(html`${card}<div hx-swap-oob="beforeend:#popup-layer">${dialog}</div>`);
}

rides.post('/cars/:carId/edit', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival, driver } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    const seatsUnknown = body.seats_unknown ? 1 : 0;
    const before = { seats_total: car.seats_total, seats_unknown: car.seats_unknown, leaving_from: car.leaving_from, description: car.description, depart_day: car.depart_day, depart_time: car.depart_time };
    const after = {
        // When the count is unknown we keep whatever's in seats_total as a harmless
        // placeholder (the flag hides it) rather than clobbering it, so unchecking
        // "idk" later brings the old number back.
        seats_total: seatsUnknown ? car.seats_total : Math.max(1, Number(body.seats_total) || car.seats_total),
        seats_unknown: seatsUnknown,
        leaving_from: (body.leaving_from || '').toString().trim() || null,
        description: (body.description || '').toString().trim() || null,
        depart_day: (body.depart_day || '').toString() || null,
        depart_time: (body.depart_time || '').toString() || null,
    };

    await db.prepare('UPDATE cars SET seats_total=?, seats_unknown=?, leaving_from=?, description=?, depart_day=?, depart_time=? WHERE id=?')
        .bind(after.seats_total, after.seats_unknown, after.leaving_from, after.description, after.depart_day, after.depart_time, car.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'cars', entityId: car.id,
        before, after, reversible: true, effects: fieldEffects('cars', car.id, before, after),
        summary: `${person ? person.display_name : 'someone'} updated ${driver.display_name}'s car`,
    });

    return carResponse(c, festival, car.id, true, body.chat_open === '1');
});

rides.post('/cars/:carId/delete', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival, driver } = loaded;
    const db = c.env.DB;
    const person = c.get('person');

    const stamp = sqlNow();
    await db.prepare('UPDATE cars SET deleted_at = ? WHERE id = ?').bind(stamp, car.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'cars', entityId: car.id,
        reversible: true, effects: [deleteEffect('cars', car.id, stamp)],
        summary: `${person ? person.display_name : 'someone'} deleted ${driver.display_name}'s car`,
    });

    return c.html('');
});

rides.post('/cars/:carId/seats/claim', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    const { car, festival, driver } = loaded;
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${car.id}` });
    const db = c.env.DB;
    const person = c.get('person');

    const result = await db.prepare('INSERT INTO seats (car_id, person_id) VALUES (?, ?)').bind(car.id, person.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'seats', entityId: result.meta.last_row_id,
        reversible: true, effects: [createEffect('seats', result.meta.last_row_id, sqlNow())],
        summary: `${person.display_name} claimed a seat in ${driver.display_name}'s car`,
    });

    // After the response — the click shouldn't wait on the email provider.
    c.executionCtx.waitUntil(notify(c.env, {
        festivalId: festival.id, targetPersonId: car.driver_person_id, actorPersonId: person.id,
        heading: `${person.display_name} grabbed a seat`,
        body: `${person.display_name} grabbed a seat in your car for ${festival.name}.`,
    }));

    const body = await c.req.parseBody();
    return carResponse(c, festival, car.id, true, body.chat_open === '1');
});

// Popup: pick a fest person to add to this car, or open the "new person" cascade.
rides.get('/cars/:carId/add-window', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival } = loaded;
    const db = c.env.DB;
    const candidates = (await db.prepare(`
        SELECT pe.id, pe.display_name, pe.is_placeholder FROM memberships m
        JOIN people pe ON pe.id = m.person_id
        WHERE m.festival_id = ? AND m.bailed_at IS NULL
          AND pe.id NOT IN (SELECT person_id FROM seats WHERE car_id = ? AND deleted_at IS NULL)
        ORDER BY pe.is_placeholder, pe.display_name
    `).bind(festival.id, car.id).all()).results;

    return c.html(xpPopup({
        title: 'Add Person to Car',
        id: `add-car-${car.id}`,
        body: html`
          ${candidates.length ? html`<div class="pick-list">
            ${candidates.map((p) => html`<button class="pick-row" type="button"
                hx-post="/cars/${car.id}/seats/add" hx-vals='${JSON.stringify({ person_id: p.id })}'
                hx-target="#car-${car.id}" hx-swap="outerHTML"
                hx-on::after-request="if(event.detail.successful) this.remove()">
                <span class="pick-emoji">${p.is_placeholder ? '👤' : '🙂'}</span>
                <span class="pick-name">${p.display_name}${p.is_placeholder ? html`<span class="ghost-badge">added manually</span>` : ''}</span>
              </button>`)}
          </div>` : html`<p class="pick-empty">There is no one to add — everyone in this fest is already in this car.</p>`}
          <hr class="popup-divider">
          <button class="btn btn-primary" type="button" style="width:100%"
            hx-get="/cars/${car.id}/add-new-window" hx-target="#popup-layer" hx-swap="beforeend">Add Someone New…</button>`,
    }));
});

// Add an existing fest person (real or placeholder) to this car.
rides.post('/cars/:carId/seats/add', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival, driver } = loaded;
    const db = c.env.DB;
    const actor = c.get('person');
    const personId = Number((await c.req.parseBody()).person_id);
    const target = await db.prepare('SELECT * FROM people WHERE id = ?').bind(personId).first();
    if (!target) return carResponse(c, festival, car.id, true);

    const seated = await db.prepare('SELECT 1 FROM seats WHERE car_id = ? AND person_id = ? AND deleted_at IS NULL').bind(car.id, personId).first();
    if (!seated) {
        await ensureMembershipForPerson(db, festival.id, personId);
        const result = await db.prepare('INSERT INTO seats (car_id, person_id) VALUES (?, ?)').bind(car.id, personId).run();
        await logAction(c, {
            festivalId: festival.id, action: 'create', entityType: 'seats', entityId: result.meta.last_row_id,
            reversible: true, effects: [createEffect('seats', result.meta.last_row_id, sqlNow())],
            summary: `${actor.display_name} added ${target.display_name} to ${driver.display_name}'s car`,
        });
    }
    return carResponse(c, festival, car.id, true, false, addedDialog(`${target.display_name} was successfully added to ${driver.display_name}'s car.`));
});

// Cascading popup: type a brand-new name to add them to this car (and the ppl list).
rides.get('/cars/:carId/add-new-window', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car } = loaded;
    return c.html(xpPopup({
        title: 'New Person',
        id: `add-car-new-${car.id}`,
        body: html`
          <p class="popup-hint">Add a camper who has not signed up yet. They will be placed in this car and on the ppl list. When they sign in with this name, everything links up automatically.</p>
          <form class="popup-form" hx-post="/cars/${car.id}/seats/add-new" hx-target="#car-${car.id}" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)" autocomplete="off">
            <input type="text" name="name" placeholder="Type their name" required data-1p-ignore data-lpignore="true">
            <button class="btn btn-primary" type="submit">Add to Car</button>
          </form>`,
    }));
});

rides.post('/cars/:carId/seats/add-new', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival, driver } = loaded;
    const db = c.env.DB;
    const actor = c.get('person');
    const name = ((await c.req.parseBody()).name || '').toString().trim();
    if (!name) return carResponse(c, festival, car.id, true);

    const ghost = await createPlaceholder(c, festival.id, name); // creates + joins fest
    await db.prepare('INSERT INTO seats (car_id, person_id) VALUES (?, ?)').bind(car.id, ghost.id).run();
    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'people', entityId: ghost.id,
        summary: `${actor.display_name} added ${name} to ${driver.display_name}'s car`,
    });
    return carResponse(c, festival, car.id, true, false, addedDialog(`${name} was successfully added to ${driver.display_name}'s car.`));
});

// XP "are you sure?" dialog for kicking selected passengers out of a car. The
// roster's checkboxes gather the seat ids client-side (campCarConfirmRemove) and
// hand them here as ?ids=; we look the names up server-side so the message can't be
// spoofed and reuse the shared xpDialogPopup chrome with a warning icon + Yes/No.
rides.get('/cars/:carId/seats/remove-window', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, driver } = loaded;
    const db = c.env.DB;
    const ids = (c.req.query('ids') || '').split(',').map(Number).filter(Boolean);
    if (!ids.length) return c.html('');
    const seats = (await db.prepare(`
        SELECT s.id, pe.display_name FROM seats s
        JOIN people pe ON pe.id = s.person_id
        WHERE s.car_id = ? AND s.deleted_at IS NULL AND s.id IN (${ids.map(() => '?').join(',')})
        ORDER BY s.created_at
    `).bind(car.id, ...ids).all()).results;
    if (!seats.length) return c.html('');

    const who = seats.length === 1 ? html`<b>${seats[0].display_name}</b>` : html`these <b>${seats.length}</b> passengers`;
    return c.html(xpDialogPopup({
        title: seats.length === 1 ? 'Remove Passenger' : 'Remove Passengers',
        id: `remove-seats-${car.id}`,
        icon: 'warning',
        message: html`Are you sure you want to remove ${who} from ${driver.display_name}'s car?`,
        buttons: html`
          <button class="btn btn-primary" type="button"
            hx-post="/cars/${car.id}/seats/remove" hx-vals='${JSON.stringify({ seat_ids: seats.map((s) => s.id).join(',') })}'
            hx-target="#car-${car.id}" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)">Yes, Remove</button>
          <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>`,
    }));
});

// Soft-hide one or more seats in a car — fully undoable. One audit entry carries a
// deleteEffect per seat (same shape the single-seat "leave" logs), so the engine
// restores the whole batch in one revert.
rides.post('/cars/:carId/seats/remove', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival, driver } = loaded;
    const db = c.env.DB;
    const actor = c.get('person');
    const ids = ((await c.req.parseBody()).seat_ids || '').toString().split(',').map(Number).filter(Boolean);
    if (!ids.length) return carResponse(c, festival, car.id, true);

    const seats = (await db.prepare(`
        SELECT s.id, pe.display_name FROM seats s
        JOIN people pe ON pe.id = s.person_id
        WHERE s.car_id = ? AND s.deleted_at IS NULL AND s.id IN (${ids.map(() => '?').join(',')})
        ORDER BY s.created_at
    `).bind(car.id, ...ids).all()).results;
    if (!seats.length) return carResponse(c, festival, car.id, true);

    const stamp = sqlNow();
    await db.batch(seats.map((s) => db.prepare('UPDATE seats SET deleted_at = ? WHERE id = ?').bind(stamp, s.id)));

    const names = seats.map((s) => s.display_name);
    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'seats', entityId: seats[0].id,
        reversible: true, effects: seats.map((s) => deleteEffect('seats', s.id, stamp)),
        summary: `${actor ? actor.display_name : 'someone'} removed ${names.join(', ')} from ${driver.display_name}'s car`,
    });

    return carResponse(c, festival, car.id, true);
});

// XP "are you sure?" dialog for a driver leaving their own car — replaces the old
// native hx-confirm. We look up the driver's own seat here so the Yes button knows
// which seat to release, and pass chat_open through so the re-rendered card keeps
// the chat window in whatever state it was.
rides.get('/cars/:carId/leave-window', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return c.html('');
    const seat = await db.prepare('SELECT id FROM seats WHERE car_id = ? AND person_id = ? AND deleted_at IS NULL').bind(car.id, person.id).first();
    if (!seat) return c.html('');

    return c.html(xpDialogPopup({
        title: 'Leave Car',
        id: `leave-car-${car.id}`,
        icon: 'warning',
        message: html`You're the driver of this car. Leave anyway? It'll stay listed but riderless until you rejoin.`,
        buttons: html`
          <button class="btn btn-primary" type="button"
            hx-post="/seats/${seat.id}/leave" hx-vals='js:{chat_open: document.getElementById("chat-car-${car.id}")?.open ? 1 : 0}'
            hx-target="#car-${car.id}" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)">Leave Car</button>
          <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>`,
    }));
});

rides.post('/seats/:seatId/leave', async (c) => {
    const id = Number(c.req.param('seatId'));
    const db = c.env.DB;
    const seat = await db.prepare('SELECT * FROM seats WHERE id = ?').bind(id).first();
    if (!seat) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${seat.car_id}` });
    const person = c.get('person');
    const car = await db.prepare('SELECT * FROM cars WHERE id = ?').bind(seat.car_id).first();
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(car.festival_id).first();
    const driver = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(car.driver_person_id).first();

    const stamp = sqlNow();
    await db.prepare('UPDATE seats SET deleted_at = ? WHERE id = ?').bind(stamp, id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'seats', entityId: id,
        reversible: true, effects: [deleteEffect('seats', id, stamp)],
        summary: `${person ? person.display_name : 'someone'} left ${driver.display_name}'s car`,
    });

    // After the response — the click shouldn't wait on the email provider.
    c.executionCtx.waitUntil(notify(c.env, {
        festivalId: festival.id, targetPersonId: car.driver_person_id, actorPersonId: person ? person.id : null,
        heading: `a seat opened up`,
        body: `${person ? person.display_name : 'someone'} left your car for ${festival.name} — seat's open again.`,
    }));

    const body = await c.req.parseBody();
    return carResponse(c, festival, car.id, true, body.chat_open === '1');
});

rides.post('/cars/:carId/comments', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    const { car, festival, driver } = loaded;
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${car.id}` });
    const person = c.get('person');
    return handleCommentPost(c, {
        festival, targetType: 'car', targetId: car.id,
        ownerPersonId: car.driver_person_id,
        summary: `${person.display_name} commented on ${driver.display_name}'s car`,
        notifyHeading: `${person.display_name} commented on your car`,
        notifyBody: (text) => `${person.display_name} said "${text}" on your car thread (${festival.name}).`,
        respond: () => carResponse(c, festival, car.id, true, true),
    });
});
