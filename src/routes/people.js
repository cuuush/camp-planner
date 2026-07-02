import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';

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
    <p class="ppl-count">${members.length} ${members.length === 1 ? 'person' : 'people'} going</p>
    <div class="ppl-list">
      ${members.map((m) => html`
        <div class="ppl-row">
          <span class="ppl-name">${m.display_name}</span>
          ${tasks.length ? html`<span class="ppl-tasks">${tasks.map((t) => {
              const done = isChecked(t.id, m.person_id);
              return html`<span class="ppl-task ${done ? 'done' : ''}">${done ? '✅' : '⬜'} ${t.label}</span>`;
          })}</span>` : ''}
        </div>`)}
    </div>
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
    if (needsSignin(c)) return signinModalResponse(c);
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
    if (needsSignin(c)) return signinModalResponse(c);
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
    if (needsSignin(c)) return signinModalResponse(c);
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

people.post('/checklist/:taskId/delete', async (c) => {
    if (needsSignin(c)) return signinModalResponse(c);
    const taskId = Number(c.req.param('taskId'));
    const db = c.env.DB;
    const person = c.get('person');

    const task = await db.prepare('SELECT * FROM checklist_tasks WHERE id = ? AND deleted_at IS NULL').bind(taskId).first();
    if (!task) return c.notFound();
    if (task.is_default) return c.notFound();
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(task.festival_id).first();

    await db.prepare("UPDATE checklist_tasks SET deleted_at = datetime('now') WHERE id = ?").bind(taskId).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'checklist_tasks', entityId: taskId,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} removed checklist column "${task.label}"`,
    });

    return c.html(await renderPplBody(c, festival));
});

people.post('/f/:id/people/:personId/bail', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
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
