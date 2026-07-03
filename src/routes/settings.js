import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { logAction } from '../lib/audit.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { xpPopup } from '../render/popup.js';

export const settings = new Hono();

// The email/notifications form on its own so a save can re-render just this
// fragment (hx-target="this") with a little "saved!" receipt.
function emailForm(person, saved = false) {
    return html`
    <form class="settings-email-form" method="post" action="/settings/email"
      hx-post="/settings/email" hx-target="this" hx-swap="outerHTML">
      <p class="settings-hint">get an email when someone grabs a seat in your car, pledges your item, or chats at you. added it at sign-up? change it here.</p>
      <input type="email" name="email" value="${person.email || ''}" placeholder="you@example.com">
      <label class="xp-check-label" style="margin-top:10px;">
        <input type="checkbox" class="xp-check-input" name="notify" value="1" ${person.email_unsubscribed ? '' : 'checked'}>
        <span class="xp-checkbox"></span>
        email me when stuff happens
      </label>
      <div class="dialog-buttons" style="margin-top:12px;">
        <button class="btn btn-primary" type="submit">apply</button>
      </div>
      ${saved ? html`<p class="settings-saved">✅ saved!</p>` : ''}
    </form>`;
}

// The whole Control Panel body — shared by the popup window and the full-page
// fallback. Clock + effects are per-device prefs (localStorage, filled in by
// campInitSettings client-side); the account section is real server state.
function settingsBody(person) {
    return html`
    <fieldset>
      <legend>date and time</legend>
      <p class="settings-hint">times around the site show in your device's time zone.</p>
      <label class="xp-radio-label"><input type="radio" name="camp_time_fmt" value="12" onchange="campSetTimeFmt('12')"> 12-hour (3:04 PM)</label>
      <label class="xp-radio-label"><input type="radio" name="camp_time_fmt" value="24" onchange="campSetTimeFmt('24')"> 24-hour (15:04)</label>
    </fieldset>
    <fieldset>
      <legend>user accounts</legend>
      ${person
        ? emailForm(person)
        : html`<p class="settings-hint">you're not signed in — sign in first, then you can add an email for notifications.</p>
          <button class="btn btn-primary" type="button"
            hx-get="/signin/modal" hx-target="#signin-modal-overlay" hx-swap="innerHTML">sign in</button>`}
    </fieldset>
    <fieldset>
      <legend>visual effects</legend>
      <label class="xp-check-label">
        <input type="checkbox" class="xp-check-input" id="camp-fx-check" onchange="campSetConfetti(this.checked, this.parentElement)">
        <span class="xp-checkbox"></span>
        confetti &amp; celebrations
      </label>
    </fieldset>`;
}

// The Control Panel as a floating XP window (start menu → control panel).
settings.get('/settings/window', async (c) => {
    return c.html(xpPopup({
        title: 'Control Panel',
        id: 'control-panel',
        wide: true,
        body: settingsBody(c.get('person')),
    }));
});

// Full-page fallback for no-JS / direct navigation to /settings.
settings.get('/settings', async (c) => {
    const body = html`<div class="card"><h2 style="margin-top:0;">Control Panel</h2>${settingsBody(c.get('person'))}</div>`;
    return c.html(await renderPage(c, { title: 'control panel', body }));
});

settings.post('/settings/email', async (c) => {
    if (needsSignin(c)) return signinModalResponse(c);
    const person = c.get('person');
    const body = await c.req.parseBody();
    const email = (body.email || '').toString().trim() || null;
    const unsubscribed = body.notify ? 0 : 1;

    await c.env.DB.prepare('UPDATE people SET email = ?, email_unsubscribed = ? WHERE id = ?')
        .bind(email, unsubscribed, person.id).run();

    await logAction(c, {
        action: 'update', entityType: 'people', entityId: person.id,
        summary: `${person.display_name} updated their email settings`,
    });

    person.email = email;
    person.email_unsubscribed = unsubscribed;

    if (c.req.header('HX-Request') === 'true') return c.html(emailForm(person, true));
    return c.redirect('/settings');
});
