import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival, ensureMembershipForPerson } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { createPlaceholder } from '../lib/people.js';
import { msnChat, escapeHtml } from '../render/msn.js';
import { xpPopup } from '../render/popup.js';

export const rides = new Hono();

async function carStats(db, car) {
    const seats = (await db.prepare(`
        SELECT s.id, s.person_id, pe.display_name FROM seats s
        JOIN people pe ON pe.id = s.person_id
        WHERE s.car_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at
    `).bind(car.id).all()).results;

    const comments = (await db.prepare(`
        SELECT c.id, c.body, pe.display_name FROM comments c
        JOIN people pe ON pe.id = c.person_id
        WHERE c.target_type = 'car' AND c.target_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at
    `).bind(car.id).all()).results;

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
            <div class="item-tally">
              ${seats.length}/${car.seats_total} seats taken
              ${openSeats > 0 ? html`<span class="tally-covered">· ${openSeats} open!</span>` : html`<span style="color:#888">· full</span>`}
            </div>
            <div class="item-description">leaving from ${car.leaving_from || '?'} on ${car.depart_day || '?'} ${car.depart_time || ''}</div>
          </div>
        </div>
      </summary>

      <div class="item-actions">
        <p class="car-riders"><b>in the car:</b> ${riders.length ? riders.map((s) => `${s.display_name}${isDriver(s) ? ' (driver)' : ''}`).join(', ') : '(empty — even the driver bailed)'}</p>

        <div class="action-buttons">
          ${!myTakenSeat ? html`
            <form class="car-seat-form" hx-post="/cars/${car.id}/seats/claim" hx-target="#car-${car.id}" hx-swap="outerHTML">
              <button class="btn btn-primary" type="submit">${openSeats > 0 ? 'grab an open seat' : 'squeeze in anyway'}</button>
            </form>` : person && person.id === car.driver_person_id ? html`
            <form class="car-seat-form"><button class="btn" type="button" disabled>you're driving 🚗</button></form>` : html`
            <form class="car-seat-form" hx-post="/seats/${myTakenSeat.id}/leave" hx-target="#car-${car.id}" hx-swap="outerHTML">
              <button class="btn" type="submit">leave this car</button>
            </form>`}

          <button class="btn" type="button" hx-get="/cars/${car.id}/add-window" hx-target="#popup-layer" hx-swap="beforeend">＋ add person to car</button>

          <details class="edit-toggle">
            <summary class="btn btn-like">edit</summary>
            <form class="edit-panel" hx-post="/cars/${car.id}/edit" hx-target="#car-${car.id}" hx-swap="outerHTML">
              <div class="edit-panel-title">edit car</div>
              <div class="edit-field"><label>seats</label><input type="number" name="seats_total" value="${car.seats_total}" min="1"></div>
              <div class="edit-field"><label>from</label><input type="text" name="leaving_from" value="${car.leaving_from || ''}" placeholder="e.g. oakland"></div>
              <div class="edit-field"><label>day</label><input type="text" name="depart_day" value="${car.depart_day || ''}" placeholder="thu"></div>
              <div class="edit-field"><label>time</label><input type="text" name="depart_time" value="${car.depart_time || ''}" placeholder="9am"></div>
              <div class="edit-panel-buttons">
                <button class="btn btn-primary" type="submit">save</button>
                <button class="btn btn-danger" type="submit" formaction="/cars/${car.id}/delete" hx-post="/cars/${car.id}/delete" hx-confirm="delete this car?">delete</button>
              </div>
            </form>
          </details>

          ${msnChat({
              title: `Chat (${comments.length} message${comments.length === 1 ? '' : 's'})`,
              dpEmoji: '🚗',
              toLabel: `To: <b>${escapeHtml(driverName)}'s car</b> &lt;riders@camp&gt;`,
              comments,
              postUrl: `/cars/${car.id}/comments`,
              target: `#car-${car.id}`,
              chatOpen,
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

    return html`

    <details class="card post-car">
      <summary class="post-car-summary"><b>＋ post a car</b></summary>
      <form class="edit-panel" hx-post="/f/${festival.id}/cars" hx-target="#car-list" hx-swap="innerHTML"
        hx-on::after-request="if(event.detail.successful) this.reset();">
        <div class="edit-panel-title">post a car</div>
        <p class="popup-hint" style="margin:0;">you're the driver — you get the first seat automatically.</p>
        <div class="edit-field"><label>seats</label><input type="number" name="seats_total" value="4" min="1" title="total seats, including yours"></div>
        <div class="edit-field"><label>from</label><input type="text" name="leaving_from" placeholder="e.g. oakland"></div>
        <div class="edit-field"><label>day</label><input type="text" name="depart_day" placeholder="thu"></div>
        <div class="edit-field"><label>time</label><input type="text" name="depart_time" placeholder="9am"></div>
        <div class="edit-panel-buttons"><button class="btn btn-primary" type="submit">post car</button></div>
      </form>
    </details>

    <div id="car-list">
      ${cars.length === 0 ? html`<p class="stuff-empty">no cars posted yet — post the first one!</p>` : ''}
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

    const result = await db.prepare(`
        INSERT INTO cars (festival_id, driver_person_id, seats_total, leaving_from, depart_day, depart_time)
        VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
        festival.id, person.id,
        Math.max(1, Number(body.seats_total) || 1),
        (body.leaving_from || '').toString() || null,
        (body.depart_day || '').toString() || null,
        (body.depart_time || '').toString() || null,
    ).run();

    // The driver rides in their own car — seat them right away so the riders
    // list starts with them instead of looking empty.
    await db.prepare('INSERT INTO seats (car_id, person_id) VALUES (?, ?)')
        .bind(result.meta.last_row_id, person.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'cars', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person.display_name} posted a car (${body.seats_total || 1} seats)`,
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

async function carResponse(c, festival, carId, expanded = true, chatOpen = false) {
    const db = c.env.DB;
    const person = c.get('person');
    const car = await db.prepare('SELECT * FROM cars WHERE id = ?').bind(carId).first();
    if (!car || car.deleted_at) return c.html('');
    const driver = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(car.driver_person_id).first();
    return c.html(carCard(car, driver.display_name, await carStats(db, car), person, expanded, chatOpen));
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
        before, after, reversible: true,
        summary: `${person ? person.display_name : 'someone'} updated a car's details`,
    });

    return carResponse(c, festival, car.id);
});

rides.post('/cars/:carId/delete', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car, festival, driver } = loaded;
    const db = c.env.DB;
    const person = c.get('person');

    await db.prepare("UPDATE cars SET deleted_at = datetime('now') WHERE id = ?").bind(car.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'cars', entityId: car.id,
        reversible: true,
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
        reversible: true,
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
        title: 'Add person to car',
        id: `add-car-${car.id}`,
        body: html`
          ${candidates.length ? html`<div class="pick-list">
            ${candidates.map((p) => html`<button class="pick-row" type="button"
                hx-post="/cars/${car.id}/seats/add" hx-vals='${JSON.stringify({ person_id: p.id })}'
                hx-target="#car-${car.id}" hx-swap="outerHTML"
                hx-on::after-request="if(event.detail.successful) this.remove()">
                <span class="pick-emoji">${p.is_placeholder ? '👤' : '🙂'}</span>
                <span class="pick-name">${p.display_name}${p.is_placeholder ? html`<span class="ghost-badge">not signed up</span>` : ''}</span>
              </button>`)}
          </div>` : html`<p class="pick-empty">everyone in this fest is already in this car.</p>`}
          <hr class="popup-divider">
          <button class="btn btn-primary" type="button" style="width:100%"
            hx-get="/cars/${car.id}/add-new-window" hx-target="#popup-layer" hx-swap="beforeend">＋ add someone new</button>`,
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
            reversible: true,
            summary: `${actor.display_name} added ${target.display_name} to ${driver.display_name}'s car`,
        });
    }
    return carResponse(c, festival, car.id, true);
});

// Cascading popup: type a brand-new name to add them to this car (and the ppl list).
rides.get('/cars/:carId/add-new-window', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `car-${loaded.car.id}` });
    const { car } = loaded;
    return c.html(xpPopup({
        title: 'New person',
        id: `add-car-new-${car.id}`,
        body: html`
          <p class="popup-hint">someone who hasn't signed up yet — they'll be put in this car and on the ppl list. when they log in with this name, it links up.</p>
          <form class="popup-form" hx-post="/cars/${car.id}/seats/add-new" hx-target="#car-${car.id}" hx-swap="outerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)" autocomplete="off">
            <input type="text" name="name" placeholder="their name" required data-1p-ignore data-lpignore="true">
            <button class="btn btn-primary" type="submit">add to car</button>
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
    return carResponse(c, festival, car.id, true);
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

    await db.prepare("UPDATE seats SET deleted_at = datetime('now') WHERE id = ?").bind(id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'seats', entityId: id,
        reversible: true,
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
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const text = (body.body || '').toString().trim();
    if (!text) return carResponse(c, festival, car.id, true, true);

    const result = await db.prepare("INSERT INTO comments (target_type, target_id, person_id, body) VALUES ('car', ?, ?, ?)")
        .bind(car.id, person.id, text).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'comments', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person.display_name} commented on ${driver.display_name}'s car`,
    });

    await notify(c.env, {
        festivalId: festival.id, targetPersonId: car.driver_person_id, actorPersonId: person.id,
        heading: `${person.display_name} commented on your car`,
        body: `${person.display_name} said "${text}" on your car thread (${festival.name}).`,
    });

    return carResponse(c, festival, car.id, true, true);
});
