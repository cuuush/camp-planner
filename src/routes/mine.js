import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { isCarPassTask } from './people.js';
import { xpCaptionBtns } from '../render/popup.js';

export const mine = new Hono();

// Wrap a "me"-tab section in a little draggable XP window (title bar + caption
// buttons). `offset` nudges each window left/right (negative = left) on mobile,
// where they stack in one column; `slug` places it in the 2-column desktop grid
// (see .mine-floating in retro.css: checklist+ride stack on the left, bringing
// takes the right column). These live outside the main app window (see
// #mine-floating in layout.js) so they never render on top of it.
function miniWindow(title, slug, offset, inner) {
    return html`
    <div class="xp-mini xp-mini-${slug}" style="--mini-offset:${offset}px">
      <div class="xp-mini-titlebar">
        <span class="xp-mini-title">${title}</span>
        ${xpCaptionBtns()}
      </div>
      <div class="xp-mini-body">${inner}</div>
    </div>`;
}

// htmx fragment for partial updates: swaps the primary target (#main) as usual,
// plus an out-of-band swap for #mine-floating, which lives outside the main
// .xp-window and isn't reachable by an ordinary hx-target.
function mineFragment({ main, floating }) {
    return html`${main}<div id="mine-floating" hx-swap-oob="innerHTML">${floating}</div>`;
}

async function renderMineBody(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) {
        return { main: html`<div class="card">
          <p>sign in to see your packing list, your ride, and your checklist.</p>
          <button class="btn btn-primary" type="button"
            hx-get="/signin/modal?next=/f/${festival.id}/mine" hx-target="#signin-modal-overlay" hx-swap="innerHTML">sign in</button>
        </div>`, floating: '' };
    }

    const daysToGo = festival.start_date ? Math.ceil((new Date(festival.start_date) - new Date()) / 86400000) : null;
    const near = daysToGo !== null && daysToGo <= 14;

    const pledges = (await db.prepare(`
        SELECT p.*, i.name as item_name, i.emoji, i.unit FROM pledges p
        JOIN items i ON i.id = p.item_id
        WHERE p.person_id = ? AND p.deleted_at IS NULL AND i.festival_id = ? AND i.deleted_at IS NULL
        ORDER BY i.name
    `).bind(person.id, festival.id).all()).results;

    const tasks = (await db.prepare('SELECT * FROM checklist_tasks WHERE festival_id = ? AND deleted_at IS NULL ORDER BY id').bind(festival.id).all()).results;
    const checks = (await db.prepare(`
        SELECT * FROM checklist_checks WHERE person_id = ? AND task_id IN (SELECT id FROM checklist_tasks WHERE festival_id = ?)
    `).bind(person.id, festival.id).all()).results;
    const isChecked = (taskId) => checks.some((ch) => ch.task_id === taskId && !ch.unchecked_at);

    const drivingCar = await db.prepare('SELECT * FROM cars WHERE festival_id = ? AND driver_person_id = ? AND deleted_at IS NULL').bind(festival.id, person.id).first();
    // Exclude a seat in your OWN car: if you added yourself to the car you drive,
    // the "you're driving!" panel already covers it — a second "riding with
    // <yourself>" panel is just a confusing duplicate.
    const ridingSeat = await db.prepare(`
        SELECT s.*, c.driver_person_id, pe.display_name as driver_name FROM seats s
        JOIN cars c ON c.id = s.car_id
        JOIN people pe ON pe.id = c.driver_person_id
        WHERE s.person_id = ? AND s.deleted_at IS NULL AND c.festival_id = ?
          AND c.deleted_at IS NULL AND c.driver_person_id != ?
    `).bind(person.id, festival.id, person.id).first();

    // Signed in, everything lives in the mini windows — the main window renders
    // bare (see renderPage), so there's no main content at all.
    const main = html``;

    const floating = html`
    <div class="mine-col mine-col-left">
    ${miniWindow('Festival Checklist', 'checklist', -12, html`
      ${near ? html`<p class="rainbow" style="margin-top:0;">it's almost time — here's your 7am packing checklist!</p>` : ''}
      <div class="checklist-rows">
        ${tasks.map((t) => {
            // A car pass only matters if you're driving — if not, just don't show it.
            if (isCarPassTask(t) && !drivingCar) return '';
            return html`
          <div class="checklist-row">
            <form hx-post="/f/${festival.id}/mine/check/${t.id}" hx-target="#main" hx-swap="innerHTML" class="checklist-check">
              <button class="check-toggle" type="submit" aria-label="toggle ${t.label}"><span class="xp-checkbox ${isChecked(t.id) ? 'checked' : ''}"></span></button>
            </form>
            <span class="checklist-label">${t.label}</span>
            ${t.is_default
                ? html`<span class="checklist-req" title="everyone needs this — can't be removed">required</span>`
                : html`<form hx-post="/f/${festival.id}/mine/checklist/${t.id}/delete" hx-target="#main" hx-swap="innerHTML" class="checklist-del" hx-confirm="Are you sure you want to remove &quot;${t.label}&quot; from everyone's checklist?">
                    <button class="btn btn-danger checklist-del-btn" type="submit" title="remove this item">✕</button>
                  </form>`}
          </div>`;
        })}
      </div>
      <form class="checklist-add" hx-post="/f/${festival.id}/mine/checklist/tasks" hx-target="#main" hx-swap="innerHTML"
        hx-on::after-request="if(event.detail.successful) this.reset();">
        <input type="text" name="label" placeholder="add a checklist item…" required>
        <button class="btn" type="submit">Add</button>
      </form>
    `)}

    ${miniWindow('My Ride', 'ride', -6, html`
      ${drivingCar ? html`<a class="ride-panel" href="/f/${festival.id}/rides"><span class="ride-icon">🚗</span><div class="ride-info"><b>you're driving!</b><br>${drivingCar.seats_total} seats · leaving from ${drivingCar.leaving_from || '?'}</div><span class="ride-go">Cars ›</span></a>` : ''}
      ${ridingSeat ? html`<a class="ride-panel" href="/f/${festival.id}/rides"><span class="ride-icon">🚗</span><div class="ride-info"><b>riding with ${ridingSeat.driver_name}</b></div><span class="ride-go">Cars ›</span></a>` : ''}
      ${!drivingCar && !ridingSeat ? html`<a class="ride-panel ride-empty" href="/f/${festival.id}/rides"><span class="ride-icon">🚗</span><div class="ride-info">no ride yet — open Cars!</div><span class="ride-go">Cars ›</span></a>` : ''}
    `)}
    </div>

    <div class="mine-col mine-col-right">
    ${miniWindow("What I'm Bringing", 'bringing', 14, html`
      ${pledges.length === 0
            ? html`<p class="mine-empty">nothing pledged yet — go grab something in Stuff!</p>`
            : html`<div class="bringing-list">
          ${pledges.map((p) => html`
            <div class="bringing-row ${p.packed_at ? 'packed' : ''}">
              ${near ? html`
                <form hx-post="/pledges/${p.id}/packed" hx-target="#main" hx-swap="innerHTML" class="checklist-check">
                  <button class="check-toggle" type="submit" aria-label="toggle packed"><span class="xp-checkbox ${p.packed_at ? 'checked' : ''}"></span></button>
                </form>` : ''}
              <span class="bringing-icon">${p.emoji}</span>
              <a class="bringing-name" href="/f/${festival.id}/stuff#item-${p.item_id}">${p.item_name}</a>
              <span class="bringing-qty">${p.qty} ${p.unit || ''}</span>
              ${p.packed_at ? html`<span class="bringing-packed">✓ packed</span>` : ''}
            </div>`)}
        </div>`}
    `)}
    </div>
  `;

    return { main, floating };
}

mine.get('/f/:id/mine', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const { main, floating } = await renderMineBody(c, festival);
    // Signed in → no main window (bare): the mini windows ARE the page, and the
    // main window would just be an empty shell. Signed out it stays, holding the
    // sign-in card (and a guest's join banner always brings it back).
    return c.html(await renderPage(c, { title: `${festival.name} — About Me`, festival, activeTab: 'mine', body: main, floating, bare: !!c.get('person') }));
});

// Toggle your own checklist item from the "my list" tab. Same effect as the ppl
// tab's toggle, but re-renders the mine body so the page doesn't flip to ppl.
mine.post('/f/:id/mine/check/:taskId', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const taskId = Number(c.req.param('taskId'));

    const task = await db.prepare('SELECT * FROM checklist_tasks WHERE id = ? AND festival_id = ?').bind(taskId, festival.id).first();
    if (!task) return c.notFound();

    // Car pass is driver-only — ignore the toggle if they haven't posted a car.
    if (isCarPassTask(task)) {
        const driving = await db.prepare('SELECT 1 FROM cars WHERE festival_id = ? AND driver_person_id = ? AND deleted_at IS NULL').bind(festival.id, person.id).first();
        if (!driving) return c.html(mineFragment(await renderMineBody(c, festival)));
    }

    const existing = await db.prepare('SELECT * FROM checklist_checks WHERE task_id = ? AND person_id = ?').bind(taskId, person.id).first();
    let nowChecked;
    if (!existing) {
        await db.prepare('INSERT INTO checklist_checks (task_id, person_id) VALUES (?, ?)').bind(taskId, person.id).run();
        nowChecked = true;
    } else if (existing.unchecked_at) {
        await db.prepare("UPDATE checklist_checks SET unchecked_at = NULL, checked_at = datetime('now') WHERE id = ?").bind(existing.id).run();
        nowChecked = true;
    } else {
        await db.prepare("UPDATE checklist_checks SET unchecked_at = datetime('now') WHERE id = ?").bind(existing.id).run();
        nowChecked = false;
    }

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'checklist_checks', entityId: taskId,
        summary: `${person.display_name} ${nowChecked ? 'checked off' : 'unchecked'} "${task.label}"`,
    });

    return c.html(mineFragment(await renderMineBody(c, festival)));
});

// Anyone signed in can add a shared checklist item (it applies to everyone's list).
mine.post('/f/:id/mine/checklist/tasks', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const label = (body.label || '').toString().trim();
    if (!label) return c.html(mineFragment(await renderMineBody(c, festival)));

    const result = await db.prepare('INSERT INTO checklist_tasks (festival_id, label) VALUES (?, ?)').bind(festival.id, label).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'checklist_tasks', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} added checklist item "${label}"`,
    });

    return c.html(mineFragment(await renderMineBody(c, festival)));
});

// Remove a checklist item for everyone — but the default festival/car passes
// are required and can't be deleted.
mine.post('/f/:id/mine/checklist/:taskId/delete', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const taskId = Number(c.req.param('taskId'));

    const task = await db.prepare('SELECT * FROM checklist_tasks WHERE id = ? AND festival_id = ? AND deleted_at IS NULL').bind(taskId, festival.id).first();
    if (!task) return c.html(mineFragment(await renderMineBody(c, festival)));
    if (task.is_default) return c.html(mineFragment(await renderMineBody(c, festival))); // required — not deletable

    await db.prepare("UPDATE checklist_tasks SET deleted_at = datetime('now') WHERE id = ?").bind(taskId).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'checklist_tasks', entityId: taskId,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} removed checklist item "${task.label}"`,
    });

    return c.html(mineFragment(await renderMineBody(c, festival)));
});

mine.post('/pledges/:pledgeId/packed', async (c) => {
    if (needsSignin(c)) return signinModalResponse(c);
    const id = Number(c.req.param('pledgeId'));
    const db = c.env.DB;
    const person = c.get('person');
    const pledge = await db.prepare('SELECT * FROM pledges WHERE id = ?').bind(id).first();
    if (!pledge) return c.notFound();
    const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(pledge.item_id).first();
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(item.festival_id).first();

    const nowPacked = !pledge.packed_at;
    await db.prepare(`UPDATE pledges SET packed_at = ? WHERE id = ?`).bind(nowPacked ? new Date().toISOString() : null, id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'pledges', entityId: id,
        summary: `${person ? person.display_name : 'someone'} ${nowPacked ? 'packed' : 'unpacked'} ${item.name}`,
    });

    return c.html(mineFragment(await renderMineBody(c, festival)));
});
