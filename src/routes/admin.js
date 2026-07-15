import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribe.js';
import { needsSignin } from '../lib/guard.js';

export const admin = new Hono();

admin.get('/admin', async (c) => {
    // Signed-in campers only. The site is open by design, but this page shows
    // last-seen locations and devices — for friends' eyes, not anonymous scrapers.
    // (/unsubscribe below stays anonymous on purpose: its token IS the auth.)
    if (needsSignin(c)) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`);
    const db = c.env.DB;
    // "Users on this computer" = anyone with an active membership somewhere or a
    // live session. Removing a person from a fest bails their membership AND ends
    // their sessions, so someone deleted from their only fest drops off this list;
    // undoing the delete restores the membership and brings them back, and a fresh
    // sign-in (session, no fest yet) still shows. Merged-away identities stay,
    // annotated with where they went.
    const people = (await db.prepare(`
        SELECT p.* FROM people p
        WHERE p.merged_into IS NOT NULL
           OR (p.deleted_at IS NULL AND (
                EXISTS (SELECT 1 FROM memberships m WHERE m.person_id = p.id AND m.bailed_at IS NULL)
                OR EXISTS (SELECT 1 FROM sessions s WHERE s.person_id = p.id)))
        ORDER BY p.last_seen_at DESC
    `).all()).results;
    // For annotating merged-away identities with where they went.
    const nameById = new Map(people.map((p) => [p.id, p.display_name]));

    // One last-event lookup per person, fired together instead of sequentially.
    const rows = await Promise.all(people.map(async (p) => ({
        p,
        lastEvent: await db.prepare(`
            SELECT geo_city, geo_country, user_agent, created_at FROM audit_log
            WHERE person_id = ? ORDER BY created_at DESC LIMIT 1
        `).bind(p.id).first(),
    })));

    const body = html`
    <div class="admin-console">
      <div class="admin-head">
        <img class="admin-head-ico" src="/xp/admin.png" alt="">
        <div class="admin-head-text">
          <div class="admin-head-title">Camper Management</div>
          <div class="admin-head-sub">Administrative Tools &middot; ${people.length} user${people.length === 1 ? '' : 's'} on this computer</div>
        </div>
      </div>

      <div class="admin-notice">
        <img class="admin-notice-ico" src="/xp/tray-shield.png" alt="">
        <span>Windows is logging IP addresses on this computer for your protection. (Only kept around in case of fraud shenanigans, lol.)</span>
      </div>

      <div class="admin-listview">
        <table class="admin-table">
          <thead>
            <tr><th>Name</th><th>E-mail</th><th>Joined</th><th>Last Seen</th><th>Last Location</th><th>Last Device</th></tr>
          </thead>
          <tbody>
            ${rows.map(({ p, lastEvent }) => html`
              <tr>
                <td class="admin-name">
                  <img class="admin-user-ico" src="/xp/cp-accounts.png" alt="">
                  <span>${p.display_name}${p.merged_into ? html`<span class="admin-merged">→ ${nameById.get(p.merged_into) || `#${p.merged_into}`}</span>` : ''}</span>
                </td>
                <td>${p.email ? html`<span class="admin-yes">Yes</span>` : html`<span class="admin-no">No</span>`}</td>
                <td class="admin-date">${p.created_at}</td>
                <td class="admin-date">${p.last_seen_at}</td>
                <td>${lastEvent && (lastEvent.geo_city || lastEvent.geo_country) ? `${lastEvent.geo_city || '?'}, ${lastEvent.geo_country || '?'}` : '—'}</td>
                <td class="admin-device">${lastEvent ? (lastEvent.user_agent || '').slice(0, 40) : ''}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>
  `;

    // Titled like an XP MMC console ("Computer Management"), matching the
    // Camper Management header inside.
    return c.html(await renderPage(c, { title: 'Administrative Tools', windowTitle: 'Camper Management', body }));
});

admin.get('/unsubscribe/:personId/:token', async (c) => {
    const db = c.env.DB;
    const personId = Number(c.req.param('personId'));
    const token = c.req.param('token');
    const person = await db.prepare('SELECT * FROM people WHERE id = ?').bind(personId).first();

    let msg;
    if (!person || !(await verifyUnsubscribeToken(c.env, person, token))) {
        msg = html`<p>hmm, that link doesn't check out.</p>`;
    } else {
        await db.prepare('UPDATE people SET email_unsubscribed = 1 WHERE id = ?').bind(personId).run();
        msg = html`<p>done — ${person.display_name} won't get any more emails from camp planner.</p>`;
    }

    return c.html(await renderPage(c, { title: 'unsubscribed', body: html`<div class="card">${msg}</div>` }));
});
