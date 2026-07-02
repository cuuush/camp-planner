import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { signinForm } from '../render/signin.js';

export const mine = new Hono();

async function renderMineBody(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return signinForm();

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
    const ridingSeat = await db.prepare(`
        SELECT s.*, c.driver_person_id, pe.display_name as driver_name FROM seats s
        JOIN cars c ON c.id = s.car_id
        JOIN people pe ON pe.id = c.driver_person_id
        WHERE s.person_id = ? AND s.deleted_at IS NULL AND c.festival_id = ?
    `).bind(person.id, festival.id).first();

    return html`
    <div class="divider">★ what do I personally have to do ★</div>
    ${near ? html`<p class="rainbow">it's almost time — here's your 7am packing checklist!</p>` : ''}

    <div class="card">
      <h3>my pledges</h3>
      ${pledges.length === 0 ? html`<p>nothing pledged yet — go grab something on the stuff tab!</p>` : ''}
      ${pledges.map((p) => html`
        <div>
          ${near ? html`
            <form hx-post="/pledges/${p.id}/packed" hx-target="#main" hx-swap="innerHTML" style="display:inline">
              <button class="btn" type="submit">${p.packed_at ? '✅' : '⬜'}</button>
            </form>` : ''}
          ${p.emoji} ${p.item_name} — ${p.qty} ${p.unit || ''} ${p.packed_at ? html`<i>(packed)</i>` : ''}
        </div>`)}
    </div>

    <div class="card">
      <h3>my checklist</h3>
      ${tasks.map((t) => html`
        <div>
          <form hx-post="/checklist/${t.id}/toggle/${person.id}" hx-target="#main" hx-swap="innerHTML" style="display:inline">
            <button class="btn" type="submit">${isChecked(t.id) ? '✅' : '⬜'}</button>
          </form>
          ${t.label}
        </div>`)}
    </div>

    <div class="card">
      <h3>my ride</h3>
      ${drivingCar ? html`<p>you're driving! ${drivingCar.seats_total} seats, leaving from ${drivingCar.leaving_from || '?'}.</p>` : ''}
      ${ridingSeat ? html`<p>riding with ${ridingSeat.driver_name}.</p>` : ''}
      ${!drivingCar && !ridingSeat ? html`<p>no ride yet — check the rides tab!</p>` : ''}
    </div>
  `;
}

mine.get('/f/:id/mine', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderMineBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — mine`, festival, activeTab: 'mine', body }));
});

mine.post('/pledges/:pledgeId/packed', async (c) => {
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

    return c.html(await renderMineBody(c, festival));
});
