import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival, ensureMembership } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { sqlNow, createEffect, deleteEffect } from '../lib/effects.js';
import { needsSignin, signinModalResponse, signinRedirect } from '../lib/guard.js';
import { createPlaceholder, mergePeople, deletePersonFootprint } from '../lib/people.js';
import { xpPopup, xpDialogPopup } from '../render/popup.js';

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
        hx-get="/f/${festival.id}/people/add-window" hx-target="#popup-layer" hx-swap="beforeend">Add Person…</button>
      ${person
          ? html`<button class="btn" type="button" onclick="campEnterSelect(this,'merge')">Merge</button>
                 <button class="btn" type="button" onclick="campEnterSelect(this,'delete')">Delete</button>`
          : html`<button class="btn" type="button" hx-get="/signin/modal?next=/f/${festival.id}/ppl" hx-target="#signin-modal-overlay" hx-swap="innerHTML">Merge</button>
                 <button class="btn" type="button" hx-get="/signin/modal?next=/f/${festival.id}/ppl" hx-target="#signin-modal-overlay" hx-swap="innerHTML">Delete</button>`}
    </div>
    <div class="ppl-select-bar" data-fest="${festival.id}" hidden>
      <span class="ppl-select-hint"></span>
      <button class="btn btn-primary ppl-select-go" type="button" disabled onclick="campRunSelect(this)">Go</button>
      <button class="btn" type="button" onclick="campCancelSelect(this)">Cancel</button>
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
    return c.html(await renderPage(c, { title: `${festival.name} — People`, festival, activeTab: 'ppl', body }));
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
        title: 'Add Person',
        id: `add-person-${festival.id}`,
        body: html`
          <p class="popup-hint">Add a camper who has not signed up yet. When they sign in with this exact name, their seats and check-offs will link up automatically.</p>
          <form class="popup-form" hx-post="/f/${festival.id}/people/add" hx-target="#main" hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)" autocomplete="off">
            <input type="text" name="name" placeholder="Type their name" required data-1p-ignore data-lpignore="true">
            <button class="btn btn-primary" type="submit">Add to List</button>
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

    const ghost = await createPlaceholder(c, festival.id, name); // creates person + joins fest
    if (ghost) {
        // Adding a ghost creates the person row AND joins them (a membership). Make it
        // undoable from the log like every other create (G9): undo hides the person
        // and bails the membership; redo brings both back.
        const membership = await db.prepare('SELECT id FROM memberships WHERE festival_id = ? AND person_id = ?')
            .bind(festival.id, ghost.id).first();
        const now = sqlNow();
        const effects = [createEffect('people', ghost.id, now)];
        if (membership) effects.push({ t: 'memberships', id: membership.id, col: 'bailed_at', from: now, to: null });
        await logAction(c, {
            festivalId: festival.id, action: 'create', entityType: 'people', entityId: ghost.id,
            reversible: true, effects,
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
// XP "are you sure?" dialogs for the ppl-tab merge / remove actions — the authentic
// replacement for the old native confirm() boxes. Names/counts are looked up here
// server-side (from the picked ids) so the message can't be spoofed, then the Yes
// button hx-posts to the real merge/delete handler and closes the popup. Mirrors the
// car-roster remove dialog in rides.js.
people.get('/f/:id/people/merge-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const ids = (c.req.query('ids') || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (ids.length !== 2) return c.html('');
    const rows = (await db.prepare(`SELECT display_name FROM people WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids).all()).results;
    if (rows.length !== 2) return c.html('');
    const [a, b] = rows.map((r) => r.display_name);
    return c.html(xpDialogPopup({
        title: 'Merge People',
        id: 'merge-people',
        icon: 'warning',
        message: html`Merge <b>${a}</b> and <b>${b}</b> into one camper? Everything they brought, pledged, and said will be combined. The real, signed-in account wins. You can undo this from the <b>log</b> tab.`,
        buttons: html`
          <button class="btn btn-primary" type="button"
            hx-post="/f/${festival.id}/people/merge" hx-vals='${JSON.stringify({ person_ids: ids.join(',') })}'
            hx-target="#main" hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)">Yes, Merge</button>
          <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>`,
    }));
});

people.get('/f/:id/people/delete-window', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const ids = (c.req.query('ids') || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (!ids.length) return c.html('');
    const rows = (await db.prepare(`SELECT display_name FROM people WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids).all()).results;
    if (!rows.length) return c.html('');
    const who = rows.length === 1
        ? html`<b>${rows[0].display_name}</b>`
        : html`these <b>${rows.length}</b> people`;
    return c.html(xpDialogPopup({
        title: rows.length === 1 ? 'Remove Person' : 'Remove People',
        id: 'remove-people',
        icon: 'warning',
        message: html`Are you sure you want to remove ${who} from <b>${festival.name}</b>? This can be undone from the <b>log</b> tab, which restores everything they did.`,
        buttons: html`
          <button class="btn btn-primary" type="button"
            hx-post="/f/${festival.id}/people/delete" hx-vals='${JSON.stringify({ person_ids: ids.join(',') })}'
            hx-target="#main" hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) closePopup(this)">Yes, Remove</button>
          <button class="btn" type="button" onclick="closePopup(this)">Cancel</button>`,
    }));
});

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
        const effects = await mergePeople(db, source.id, target.id);
        await logAction(c, {
            festivalId: festival.id, action: 'merge', entityType: 'people', entityId: target.id,
            effects, reversible: true,
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
        const { manifest, effects } = await deletePersonFootprint(db, festival.id, pid);
        // End their sessions so a removed person can't keep acting on this fest —
        // otherwise their next click would auto-rejoin them (logAction →
        // ensureMembership) and spawn fresh rows, which a later undo of THIS delete
        // would then resurrect alongside, producing states the app forbids (G3).
        // Sessions are ephemeral credentials, not undo-domain state: on undo the
        // person simply signs in again. (No-op for ghosts — they have none.)
        await db.prepare('DELETE FROM sessions WHERE person_id = ?').bind(pid).run();
        await logAction(c, {
            festivalId: festival.id, action: 'delete', entityType: 'people', entityId: pid,
            before: manifest, after: manifest, effects, reversible: true,
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
        reversible: true, effects: [createEffect('checklist_tasks', result.meta.last_row_id, sqlNow())],
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

    const stamp = sqlNow();
    await db.prepare('UPDATE checklist_tasks SET deleted_at = ? WHERE id = ?').bind(stamp, taskId).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'checklist_tasks', entityId: taskId,
        reversible: true, effects: [deleteEffect('checklist_tasks', taskId, stamp)],
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

    // Collect exactly which pledges + seats this bail releases BEFORE hiding them,
    // so undo restores them too — not just the membership flip (G2). One shared
    // stamp goes into every hidden cell and its matching effect.
    const stamp = sqlNow();
    const releasedPledges = (await db.prepare(`
        SELECT p.id FROM pledges p WHERE p.person_id = ? AND p.deleted_at IS NULL
        AND p.item_id IN (SELECT id FROM items WHERE festival_id = ?)
    `).bind(personId, festival.id).all()).results.map((r) => r.id);
    const releasedSeats = (await db.prepare(`
        SELECT s.id FROM seats s WHERE s.person_id = ? AND s.deleted_at IS NULL
        AND s.car_id IN (SELECT id FROM cars WHERE festival_id = ?)
    `).bind(personId, festival.id).all()).results.map((r) => r.id);

    await db.prepare('UPDATE memberships SET bailed_at = ? WHERE id = ?').bind(stamp, membership.id).run();
    for (const pid of releasedPledges) await db.prepare('UPDATE pledges SET deleted_at = ? WHERE id = ?').bind(stamp, pid).run();
    for (const sid of releasedSeats) await db.prepare('UPDATE seats SET deleted_at = ? WHERE id = ?').bind(stamp, sid).run();

    const effects = [
        { t: 'memberships', id: membership.id, col: 'bailed_at', from: null, to: stamp },
        ...releasedPledges.map((pid) => deleteEffect('pledges', pid, stamp)),
        ...releasedSeats.map((sid) => deleteEffect('seats', sid, stamp)),
    ];

    await logAction(c, {
        festivalId: festival.id, action: 'bail', entityType: 'memberships', entityId: membership.id,
        reversible: true, effects,
        summary: `${target ? target.display_name : 'someone'} isn't going anymore 😢 (pledges & seats released)`,
    });

    return c.html(await renderPplBody(c, festival));
});
