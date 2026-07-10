import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribe.js';

export const admin = new Hono();

admin.get('/admin', async (c) => {
    const db = c.env.DB;
    const people = (await db.prepare('SELECT * FROM people ORDER BY last_seen_at DESC').all()).results;
    // For annotating merged-away identities with where they went.
    const nameById = new Map(people.map((p) => [p.id, p.display_name]));

    const rows = [];
    for (const p of people) {
        const lastEvent = await db.prepare(`
            SELECT geo_city, geo_country, user_agent, created_at FROM audit_log
            WHERE person_id = ? ORDER BY created_at DESC LIMIT 1
        `).bind(p.id).first();
        rows.push({ p, lastEvent });
    }

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

    return c.html(await renderPage(c, { title: 'Administrative Tools', body }));
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
