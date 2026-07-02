import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { notify } from '../lib/notify.js';

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

function carCard(car, driverName, stats, person) {
    const { seats, comments } = stats;
    const open = car.seats_total - seats.length;
    const myTakenSeat = person && seats.find((s) => s.person_id === person.id);

    return html`
    <details class="card ${open > 0 ? '' : ''}" id="car-${car.id}">
      <summary>
        🚗 <b>${driverName}'s car</b> — ${seats.length}/${car.seats_total} seats taken
        ${open > 0 ? html`<b style="color:#00ff00"> (${open} open!)</b>` : html`<span style="color:#888"> (full)</span>`}
        <br>leaving from ${car.leaving_from || '?'} on ${car.depart_day || '?'} ${car.depart_time || ''}
      </summary>
      <div style="padding:8px 0">
        <p>riders: ${seats.length ? seats.map((s) => s.display_name).join(', ') : '(none yet)'}</p>

        ${!myTakenSeat ? html`
          <form hx-post="/cars/${car.id}/seats/claim" hx-target="#car-${car.id}" hx-swap="outerHTML" style="display:inline">
            <button class="btn" type="submit">tap an open seat</button>
          </form>` : html`
          <form hx-post="/seats/${myTakenSeat.id}/leave" hx-target="#car-${car.id}" hx-swap="outerHTML" style="display:inline">
            <button class="btn" type="submit">leave this car</button>
          </form>`}

        <details style="margin-top:6px">
          <summary>edit / delete car</summary>
          <form hx-post="/cars/${car.id}/edit" hx-target="#car-${car.id}" hx-swap="outerHTML">
            seats: <input type="number" name="seats_total" value="${car.seats_total}" min="1" style="width:60px">
            from: <input type="text" name="leaving_from" value="${car.leaving_from || ''}">
            day: <input type="text" name="depart_day" value="${car.depart_day || ''}" style="width:60px">
            time: <input type="text" name="depart_time" value="${car.depart_time || ''}" style="width:80px">
            <button class="btn" type="submit">save</button>
          </form>
          <form hx-post="/cars/${car.id}/delete" hx-target="#car-${car.id}" hx-swap="outerHTML" hx-confirm="delete this car?">
            <button class="btn" type="submit">delete car</button>
          </form>
        </details>

        <div style="margin-top:6px">
          ${comments.map((cm) => html`<div class="comment"><b>${cm.display_name}:</b> ${cm.body}</div>`)}
          <form hx-post="/cars/${car.id}/comments" hx-target="#car-${car.id}" hx-swap="outerHTML">
            <input type="text" name="body" placeholder="say something..." style="width:70%">
            <button class="btn" type="submit">post</button>
          </form>
        </div>
      </div>
    </details>`;
}

async function renderRidesBody(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');

    const cars = (await db.prepare(`
        SELECT c.*, pe.display_name FROM cars c
        JOIN people pe ON pe.id = c.driver_person_id
        WHERE c.festival_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at
    `).bind(festival.id).all()).results;

    return html`
    <div class="divider">★ THE CARPOOL ZONE ★</div>

    <details class="card">
      <summary><b>+ post a car</b></summary>
      <form hx-post="/f/${festival.id}/cars" hx-target="#car-list" hx-swap="innerHTML">
        seats: <input type="number" name="seats_total" value="4" min="1" style="width:60px">
        leaving from: <input type="text" name="leaving_from" placeholder="e.g. oakland">
        day: <input type="text" name="depart_day" placeholder="thu" style="width:60px">
        time: <input type="text" name="depart_time" placeholder="9am" style="width:80px">
        <button class="btn" type="submit">post car</button>
      </form>
    </details>

    <div id="car-list">
      ${cars.length === 0 ? html`<p>no cars posted yet.</p>` : ''}
      ${await Promise.all(cars.map(async (car) => carCard(car, car.display_name, await carStats(db, car), person)))}
    </div>
  `;
}

rides.get('/f/:id/rides', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderRidesBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — rides`, festival, activeTab: 'rides', body }));
});

rides.post('/f/:id/cars', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return c.html(await renderRidesBody(c, festival));
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

async function carResponse(c, festival, carId) {
    const db = c.env.DB;
    const person = c.get('person');
    const car = await db.prepare('SELECT * FROM cars WHERE id = ?').bind(carId).first();
    if (!car || car.deleted_at) return c.html('');
    const driver = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(car.driver_person_id).first();
    return c.html(carCard(car, driver.display_name, await carStats(db, car), person));
}

rides.post('/cars/:carId/edit', async (c) => {
    const loaded = await loadCar(c);
    if (!loaded) return c.notFound();
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
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return carResponse(c, festival, car.id);

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

rides.post('/seats/:seatId/leave', async (c) => {
    const id = Number(c.req.param('seatId'));
    const db = c.env.DB;
    const person = c.get('person');
    const seat = await db.prepare('SELECT * FROM seats WHERE id = ?').bind(id).first();
    if (!seat) return c.notFound();
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
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return carResponse(c, festival, car.id);
    const body = await c.req.parseBody();
    const text = (body.body || '').toString().trim();
    if (!text) return carResponse(c, festival, car.id);

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

    return carResponse(c, festival, car.id);
});
