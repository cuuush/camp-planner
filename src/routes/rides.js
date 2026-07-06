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
import { xpPopup, xpDialogPopup } from '../render/popup.js';

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
            <div class="item-description">leaving from ${car.leaving_from || '?'} on ${car.depart_day || '?'} ${car.depart_time || ''}</div>
            <div class="item-description">
              ${riders.length ? riders.map((s) => `${s.display_name}${isDriver(s) ? ' (driver)' : ''}`).join(', ') : 'empty — even the driver bailed'}
              ${openSeats > 0 ? html`<span class="tally-covered">· ${openSeats} open</span>` : ''}
            </div>
          </div>
        </div>
      </summary>

      <div class="item-actions">
        <div class="action-buttons">
          ${!myTakenSeat ? html`
            <form class="car-seat-form" hx-post="/cars/${car.id}/seats/claim" hx-target="#car-${car.id}" hx-swap="outerHTML">
              <button class="btn btn-primary" type="submit">${openSeats > 0 ? 'Grab a Seat' : 'Squeeze in Anyway?'}</button>
            </form>` : html`
            <form class="car-seat-form" hx-post="/seats/${myTakenSeat.id}/leave" hx-target="#car-${car.id}" hx-swap="outerHTML" ${person && person.id === car.driver_person_id ? `hx-confirm="You're the driver — leave this car anyway? It'll stay listed but riderless until you rejoin."` : ''}>
              <button class="btn" type="submit">${person && person.id === car.driver_person_id ? "leave (you're driving)" : 'leave this car'}</button>
            </form>`}

          <button class="btn btn-add-person" type="button" hx-get="/cars/${car.id}/add-window" hx-target="#popup-layer" hx-swap="beforeend">Add Passenger</button>

          <input type="checkbox" class="edit-toggle-checkbox" id="edit-toggle-car-${car.id}">
          <label class="btn edit-open-btn" for="edit-toggle-car-${car.id}">Edit</label>
          <button class="btn btn-primary edit-save-btn" type="submit" form="edit-form-car-${car.id}">Save</button>
            <form id="edit-form-car-${car.id}" class="edit-panel" hx-post="/cars/${car.id}/edit" hx-target="#car-${car.id}" hx-swap="outerHTML" hx-vals='js:{chat_open: document.getElementById("chat-car-${car.id}")?.open ? 1 : 0}'>
              <div class="edit-panel-title">Edit Car</div>
              <div class="edit-field"><label>seats</label><input type="number" name="seats_total" value="${car.seats_total}" min="1"></div>
              <div class="edit-field"><label>from</label><input type="text" name="leaving_from" value="${car.leaving_from || ''}" placeholder="e.g. oakland"></div>
              <div class="edit-field"><label>day</label><input type="text" name="depart_day" value="${car.depart_day || ''}" placeholder="thu"></div>
              <div class="edit-field"><label>time</label><input type="text" name="depart_time" value="${car.depart_time || ''}" placeholder="9am"></div>
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

async function renderRidesBody(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    const expand = c.req.query('expand') || '';

    const cars = (await db.prepare(`
        SELECT c.*, pe.display_name FROM cars c
        JOIN people pe ON pe.id = c.driver_person_id
        WHERE c.festival_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at
    `).bind(festival.id).all()).results;

    const members = person ? (await db.prepare(`
        SELECT pe.id, pe.display_name FROM memberships m
        JOIN people pe ON pe.id = m.person_id
        WHERE m.festival_id = ? AND m.bailed_at IS NULL
        ORDER BY pe.id = ? DESC, pe.display_name
    `).bind(festival.id, person.id).all()).results : [];

    return html`

    <details class="card post-car">
      <summary class="post-car-summary"><b>＋ post a car</b></summary>
      <form class="edit-panel" hx-post="/f/${festival.id}/cars" hx-target="#car-list" hx-swap="innerHTML"
        hx-on::after-request="if(event.detail.successful) this.reset();">
        <div class="edit-panel-title">post a car</div>
        <p class="popup-hint" style="margin:0;">You're the driver by default, and get the first seat reserved automatically — pick someone else below if you're posting on their behalf.</p>
        <div class="edit-field"><label>driver</label>
          <select name="driver_person_id">
            ${members.map((m) => html`<option value="${m.id}" ${person && m.id === person.id ? 'selected' : ''}>${m.id === person?.id ? `${m.display_name} (you)` : m.display_name}</option>`)}
          </select>
        </div>
        <div class="edit-field"><label>seats</label><input type="number" name="seats_total" value="4" min="1" title="total seats, including yours"></div>
        <div class="edit-field"><label>from</label><input type="text" name="leaving_from" placeholder="e.g. oakland"></div>
        <div class="edit-field"><label>day</label><input type="text" name="depart_day" placeholder="thu"></div>
        <div class="edit-field"><label>time</label><input type="text" name="depart_time" placeholder="9am"></div>
        <div class="edit-panel-buttons"><button class="btn btn-primary" type="submit">post car</button></div>
      </form>
    </details>

    <div id="car-list">
      ${cars.length === 0 ? html`<p class="stuff-empty">There are no cars in this view — post the first one!</p>` : ''}
      ${await Promise.all(cars.map(async (car) => carCard(car, car.display_name, await carStats(db, car), person, expand === `car-${car.id}`, expand === `car-${car.id}`)))}
    </div>
  `;
}

rides.get('/f/:id/rides', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderRidesBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — cars`, festival, activeTab: 'rides', body }));
});

rides.post('/f/:id/cars', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    // Default the driver to whoever's posting, but allow picking a fellow member
    // to post on their behalf (must already belong to this festival).
    let driverId = person.id;
    const requestedDriverId = Number(body.driver_person_id);
    if (requestedDriverId && requestedDriverId !== person.id) {
        const member = await db.prepare(`
            SELECT 1 FROM memberships WHERE festival_id = ? AND person_id = ? AND bailed_at IS NULL
        `).bind(festival.id, requestedDriverId).first();
        if (member) driverId = requestedDriverId;
    }
    const driverPerson = driverId === person.id ? person
        : await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(driverId).first();

    const result = await db.prepare(`
        INSERT INTO cars (festival_id, driver_person_id, seats_total, leaving_from, depart_day, depart_time)
        VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
        festival.id, driverId,
        Math.max(1, Number(body.seats_total) || 1),
        (body.leaving_from || '').toString() || null,
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
        summary: driverId === person.id
            ? `${person.display_name} posted a car (${body.seats_total || 1} seats)`
            : `${person.display_name} posted a car for ${driverPerson.display_name} (${body.seats_total || 1} seats)`,
    });

    const body2 = await renderRidesBody(c, festival);
    return c.html(body2);
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
    const { car, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    const before = { seats_total: car.seats_total, leaving_from: car.leaving_from, depart_day: car.depart_day, depart_time: car.depart_time };
    const after = {
        seats_total: Math.max(1, Number(body.seats_total) || car.seats_total),
        leaving_from: (body.leaving_from || '').toString() || null,
        depart_day: (body.depart_day || '').toString() || null,
        depart_time: (body.depart_time || '').toString() || null,
    };

    await db.prepare('UPDATE cars SET seats_total=?, leaving_from=?, depart_day=?, depart_time=? WHERE id=?')
        .bind(after.seats_total, after.leaving_from, after.depart_day, after.depart_time, car.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'cars', entityId: car.id,
        before, after, reversible: true, effects: fieldEffects('cars', car.id, before, after),
        summary: `${person ? person.display_name : 'someone'} updated a car's details`,
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

    await notify(c.env, {
        festivalId: festival.id, targetPersonId: car.driver_person_id, actorPersonId: person.id,
        heading: `${person.display_name} grabbed a seat`,
        body: `${person.display_name} grabbed a seat in your car for ${festival.name}.`,
    });

    return carResponse(c, festival, car.id);
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
            hx-get="/cars/${car.id}/add-new-window" hx-target="#popup-layer" hx-swap="beforeend">＋ Add Someone New…</button>`,
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

    await notify(c.env, {
        festivalId: festival.id, targetPersonId: car.driver_person_id, actorPersonId: person ? person.id : null,
        heading: `a seat opened up`,
        body: `${person ? person.display_name : 'someone'} left your car for ${festival.name} — seat's open again.`,
    });

    return carResponse(c, festival, car.id);
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
