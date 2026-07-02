import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';

export const people = new Hono();

const ARRIVAL_DAYS = ['thu', 'fri', 'sat', 'sun'];

async function renderPplBody(c, festival) {
    const db = c.env.DB;

    const members = (await db.prepare(`
        SELECT m.*, pe.display_name, pe.id as person_id FROM memberships m
        JOIN people pe ON pe.id = m.person_id
        WHERE m.festival_id = ? AND m.bailed_at IS NULL
        ORDER BY pe.display_name
    `).bind(festival.id).all()).results;

    const tasks = (await db.prepare('SELECT * FROM checklist_tasks WHERE festival_id = ? AND deleted_at IS NULL ORDER BY id').bind(festival.id).all()).results;

    const checks = (await db.prepare(`
        SELECT cc.* FROM checklist_checks cc
        JOIN checklist_tasks t ON t.id = cc.task_id
        WHERE t.festival_id = ?
    `).bind(festival.id).all()).results;

    const isChecked = (taskId, personId) => checks.some((ch) => ch.task_id === taskId && ch.person_id === personId && !ch.unchecked_at);

    return html`
    <div class="divider">★ who's coming ★</div>

    <table>
      <tr>
        <th>name</th><th>arrival</th>
        ${tasks.map((t) => html`<th>${t.label}</th>`)}
        <th></th>
      </tr>
      ${members.map((m) => html`
        <tr>
          <td>${m.display_name}</td>
          <td>
            <form hx-post="/f/${festival.id}/people/${m.person_id}/arrival" hx-target="#main" hx-swap="innerHTML">
              <select name="arrival_day" onchange="this.form.requestSubmit()">
                <option value="">?</option>
                ${ARRIVAL_DAYS.map((d) => html`<option value="${d}" ${m.arrival_day === d ? 'selected' : ''}>${d}</option>`)}
              </select>
            </form>
          </td>
          ${tasks.map((t) => html`
            <td style="text-align:center">
              <form hx-post="/checklist/${t.id}/toggle/${m.person_id}" hx-target="#main" hx-swap="innerHTML">
                <button class="btn" type="submit" style="padding:2px 8px">${isChecked(t.id, m.person_id) ? '✅' : '⬜'}</button>
              </form>
            </td>`)}
          <td>
            <form hx-post="/f/${festival.id}/people/${m.person_id}/bail" hx-target="#main" hx-swap="innerHTML" hx-confirm="${m.display_name} is bailing?! this releases their pledges and seats back to unclaimed. sure?">
              <button class="btn" type="submit">not going anymore 😢</button>
            </form>
          </td>
        </tr>`)}
    </table>

    <details style="margin-top:12px">
      <summary>+ add a checklist column</summary>
      <form hx-post="/f/${festival.id}/checklist/tasks" hx-target="#main" hx-swap="innerHTML">
        <input type="text" name="label" placeholder="e.g. rideshare app installed" required>
        <button class="btn" type="submit">add column</button>
      </form>
    </details>
  `;
}

people.get('/f/:id/ppl', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderPplBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — ppl`, festival, activeTab: 'ppl', body }));
});

people.post('/f/:id/people/:personId/arrival', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const person = c.get('person');
    const personId = Number(c.req.param('personId'));
    const body = await c.req.parseBody();
    const day = (body.arrival_day || '').toString() || null;

    const member = await db.prepare('SELECT pe.display_name FROM memberships m JOIN people pe ON pe.id = m.person_id WHERE m.festival_id = ? AND m.person_id = ?')
        .bind(festival.id, personId).first();

    await db.prepare('UPDATE memberships SET arrival_day = ? WHERE festival_id = ? AND person_id = ?')
        .bind(day, festival.id, personId).run();

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'memberships', entityId: personId,
        summary: `${member ? member.display_name : 'someone'} is arriving ${day || '(unknown day)'}`,
    });

    return c.html(await renderPplBody(c, festival));
});

people.post('/checklist/:taskId/toggle/:personId', async (c) => {
    const taskId = Number(c.req.param('taskId'));
    const personId = Number(c.req.param('personId'));
    const db = c.env.DB;
    const actor = c.get('person');

    const task = await db.prepare('SELECT * FROM checklist_tasks WHERE id = ?').bind(taskId).first();
    if (!task) return c.notFound();
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(task.festival_id).first();
    const target = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(personId).first();

    const existing = await db.prepare('SELECT * FROM checklist_checks WHERE task_id = ? AND person_id = ?').bind(taskId, personId).first();

    let nowChecked;
    if (!existing) {
        await db.prepare('INSERT INTO checklist_checks (task_id, person_id) VALUES (?, ?)').bind(taskId, personId).run();
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
        summary: `${target ? target.display_name : 'someone'} ${nowChecked ? 'checked off' : 'unchecked'} "${task.label}"${actor && actor.id !== personId ? ` (marked by ${actor.display_name})` : ''}`,
    });

    return c.html(await renderPplBody(c, festival));
});

people.post('/f/:id/checklist/tasks', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const label = (body.label || '').toString().trim();
    if (!label) return c.html(await renderPplBody(c, festival));

    const result = await db.prepare('INSERT INTO checklist_tasks (festival_id, label) VALUES (?, ?)').bind(festival.id, label).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'checklist_tasks', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} added checklist column "${label}"`,
    });

    return c.html(await renderPplBody(c, festival));
});

people.post('/f/:id/people/:personId/bail', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const personId = Number(c.req.param('personId'));
    const actor = c.get('person');

    const membership = await db.prepare('SELECT * FROM memberships WHERE festival_id = ? AND person_id = ?').bind(festival.id, personId).first();
    if (!membership) return c.html(await renderPplBody(c, festival));
    const target = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(personId).first();

    await db.prepare("UPDATE memberships SET bailed_at = datetime('now') WHERE id = ?").bind(membership.id).run();

    // Release pledges back to unclaimed.
    await db.prepare(`
        UPDATE pledges SET deleted_at = datetime('now')
        WHERE person_id = ? AND deleted_at IS NULL
        AND item_id IN (SELECT id FROM items WHERE festival_id = ?)
    `).bind(personId, festival.id).run();

    // Release car seats back to open.
    await db.prepare(`
        UPDATE seats SET deleted_at = datetime('now')
        WHERE person_id = ? AND deleted_at IS NULL
        AND car_id IN (SELECT id FROM cars WHERE festival_id = ?)
    `).bind(personId, festival.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'bail', entityType: 'memberships', entityId: membership.id,
        reversible: true,
        summary: `${target ? target.display_name : 'someone'} isn't going anymore 😢 (pledges & seats released)`,
    });

    return c.html(await renderPplBody(c, festival));
});
