import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival, ensureMembership } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { needsSignin, signinModalResponse, signinRedirect } from '../lib/guard.js';
import { createPlaceholder, mergePeople, deletePersonFootprint } from '../lib/people.js';
import { xpPopup } from '../render/popup.js';

export const people = new Hono();

const ARRIVAL_DAYS = ['thu', 'fri', 'sat', 'sun'];

// The "car pass" is the one default task only drivers deal with (a car needs a
// parking pass; passengers don't). Match on the default flag + its stable label.
export const isCarPassTask = (t) => !!t.is_default && (t.label || '').toLowerCase() === 'car pass';

async function renderPplBody(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');

    const members = (await db.prepare(`
        SELECT m.*, pe.display_name, pe.id as person_id, pe.is_placeholder FROM memberships m
        JOIN people pe ON pe.id = m.person_id
        WHERE m.festival_id = ? AND m.bailed_at IS NULL
        ORDER BY pe.is_placeholder, pe.display_name
    `).bind(festival.id).all()).results;

    const tasks = (await db.prepare('SELECT * FROM checklist_tasks WHERE festival_id = ? AND deleted_at IS NULL ORDER BY id').bind(festival.id).all()).results;

    const checks = (await db.prepare(`
        SELECT cc.* FROM checklist_checks cc
        JOIN checklist_tasks t ON t.id = cc.task_id
        WHERE t.festival_id = ?
    `).bind(festival.id).all()).results;

    const isChecked = (taskId, personId) => checks.some((ch) => ch.task_id === taskId && ch.person_id === personId && !ch.unchecked_at);

    // Only people who posted a car can hold a car pass — everyone else gets N/A.
    const driverRows = (await db.prepare('SELECT DISTINCT driver_person_id FROM cars WHERE festival_id = ? AND deleted_at IS NULL').bind(festival.id).all()).results;
    const drivers = new Set(driverRows.map((r) => r.driver_person_id));

    return html`
    <p class="ppl-count">${members.length} ${members.length === 1 ? 'person' : 'people'} going</p>
    <div class="ppl-add-bar">
      <button class="btn" type="button"
        hx-get="/f/${festival.id}/people/add-window" hx-target="#popup-layer" hx-swap="beforeend">＋ add person</button>
      ${person
          ? html`<button class="btn" type="button" onclick="campEnterSelect(this,'merge')">merge</button>
                 <button class="btn" type="button" onclick="campEnterSelect(this,'delete')">delete</button>`
          : html`<button class="btn" type="button" hx-get="/signin/modal?next=/f/${festival.id}/ppl" hx-target="#signin-modal-overlay" hx-swap="innerHTML">merge</button>
                 <button class="btn" type="button" hx-get="/signin/modal?next=/f/${festival.id}/ppl" hx-target="#signin-modal-overlay" hx-swap="innerHTML">delete</button>`}
    </div>
    <div class="ppl-select-bar" data-fest="${festival.id}" hidden>
      <span class="ppl-select-hint"></span>
      <button class="btn btn-primary ppl-select-go" type="button" disabled onclick="campRunSelect(this)">go</button>
      <button class="btn" type="button" onclick="campCancelSelect(this)">cancel</button>
    </div>
    <div class="ppl-list">
      ${members.map((m) => html`
        <div class="ppl-row">
          <label class="ppl-select-box"><input type="checkbox" class="ppl-select-check" value="${m.person_id}"
            data-name="${m.display_name}" data-real="${m.is_placeholder ? 0 : 1}"></label>
          <span class="ppl-name">${m.display_name}</span>
          ${tasks.length ? html`<span class="ppl-tasks">${tasks.map((t) => {
              // Non-drivers don't need a car pass — render a blank placeholder cell
              // (not nothing) so the other columns stay vertically aligned across rows.
              if (isCarPassTask(t) && !drivers.has(m.person_id)) return html`<span class="ppl-task blank"></span>`;

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

// Explicit "I'm going" — the join button shown when you're viewing a fest you
// haven't joined yet. Plain form post (full nav) so the banner disappears on the
// reload; lands you on the ppl list where you now appear.
people.post('/f/:id/join', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinRedirect(c);

    await ensureMembership(c, festival.id);
    const person = c.get('person');
    await logAction(c, {
        festivalId: festival.id, action: 'join', entityType: 'memberships', entityId: person.id,
        summary: `${person.display_name} is going to ${festival.name}! 🎉`,
    });

    return c.redirect(`/f/${festival.id}/ppl`);
});

// --- placeholder people: manually added by name, not yet logged in ---

// Popup window: type a name to add a not-yet-signed-up person to the ppl list.
people.get('/f/:id/people/add-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    return c.html(xpPopup({
        title: 'Add person',
        id: `add-person-${festival.id}`,
        body: html`
          <p class="popup-hint">add someone who hasn't signed up yet. when they log in with this exact name, their seats &amp; check-offs link up automatically.</p>
          <form class="popup-form" hx-post="/f/${festival.id}/people/add" hx-target="#main" hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)" autocomplete="off">
            <input type="text" name="name" placeholder="their name" required data-1p-ignore data-lpignore="true">
            <button class="btn btn-primary" type="submit">add to list</button>
          </form>`,
    }));
});

people.post('/f/:id/people/add', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const person = c.get('person');
    const body = await c.req.parseBody();
    const name = (body.name || '').toString().trim();
    if (!name) return c.html(await renderPplBody(c, festival));

    const ghost = await createPlaceholder(c, festival.id, name);
    if (ghost) {
        await logAction(c, {
            festivalId: festival.id, action: 'create', entityType: 'people', entityId: ghost.id,
            reversible: false,
            summary: `${person.display_name} added ${name} to the list`,
        });
    }
    return c.html(await renderPplBody(c, festival));
});

// Merge two selected people (from the "merge people" checkbox mode). A real,
// logged-in account always wins as the surviving identity and the placeholder is
// absorbed into it. Two real accounts CAN be merged too — for when someone signed
// in twice under slightly different names — in which case the first-selected one
// survives. If both are placeholders, the first stays and the second folds in.
people.post('/f/:id/people/merge', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const actor = c.get('person');
    const body = await c.req.parseBody();
    const ids = (body.person_ids || '').toString().split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (ids.length !== 2) return c.html(await renderPplBody(c, festival));

    const a = await db.prepare('SELECT * FROM people WHERE id = ?').bind(ids[0]).first();
    const b = await db.prepare('SELECT * FROM people WHERE id = ?').bind(ids[1]).first();
    if (a && b && a.id !== b.id) {
        // target = the real one (or first-selected if both same kind); source = the other.
        let target = a, source = b;
        if (a.is_placeholder && !b.is_placeholder) { target = b; source = a; }
        await mergePeople(db, source.id, target.id);
        await logAction(c, {
            festivalId: festival.id, action: 'update', entityType: 'people', entityId: target.id,
            summary: `${actor.display_name} merged ${source.display_name} into ${target.display_name}`,
        });
    }
    return c.html(await renderPplBody(c, festival));
});

// Delete one or more people from a fest — fully reversible. Nothing is destroyed:
// their whole footprint (pledges, seats, votes, comments, their car, checks,
// membership) is soft-hidden and recorded in a manifest, so a single undo brings
// every last thing back.
people.post('/f/:id/people/delete', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const actor = c.get('person');
    const body = await c.req.parseBody();
    const ids = (body.person_ids || '').toString().split(',').map((s) => Number(s.trim())).filter(Boolean);

    for (const pid of ids) {
        const target = await db.prepare('SELECT display_name FROM people WHERE id = ?').bind(pid).first();
        if (!target) continue;
        const manifest = await deletePersonFootprint(db, festival.id, pid);
        await logAction(c, {
            festivalId: festival.id, action: 'delete', entityType: 'people', entityId: pid,
            before: manifest, after: manifest, reversible: true,
            summary: `${actor.display_name} removed ${target.display_name} from ${festival.name} — undo to restore everything`,
        });
    }
    return c.html(await renderPplBody(c, festival));
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

    // A car pass is only checkable by someone who's posted a car.
    if (isCarPassTask(task)) {
        const driving = await db.prepare('SELECT 1 FROM cars WHERE festival_id = ? AND driver_person_id = ? AND deleted_at IS NULL').bind(festival.id, personId).first();
        if (!driving) return c.html(await renderPplBody(c, festival));
    }

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
