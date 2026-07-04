import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { logAction } from '../lib/audit.js';
import { xpPopup } from '../render/popup.js';
import { msnify, nameColor } from '../render/msn.js';

export const feedback = new Hono();

async function feedbackEntries(db) {
    return (await db.prepare(`
        SELECT f.*, pe.display_name FROM feedback f
        LEFT JOIN people pe ON pe.id = f.person_id
        WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC, f.id DESC LIMIT 100
    `).all()).results;
}

// The feedback window body: a Windows-Error-Reporting-style compose box up top
// ("Send Error Report" / "Don't Send"), then the log of previously sent reports.
// Shared by the popup and the /feedback full-page fallback; POST re-renders it
// in place so a fresh report shows up at the top of the list immediately.
function feedbackBody(person, entries, sent = false) {
    const from = person ? person.display_name : 'anonymous';
    return html`
    <div id="feedback-body">
      <div class="xp-dialog-prompt" style="margin-bottom:10px;">
        <img class="xp-dialog-icon" src="/notify.png" alt="" aria-hidden="true">
        <div class="xp-dialog-msg">
          <b>camp planner has encountered your opinion and needs to hear it. We are sorry for the inconvenience.</b><br>
          <span class="settings-hint" style="margin:0;">Please tell camp planner about this problem. We have created a report form below that you can send to help us improve camp planner. This report will be sent as <b>${from}</b>.</span>
        </div>
      </div>
      <form class="feedback-form" method="post" action="/feedback"
        hx-post="/feedback" hx-target="#feedback-body" hx-swap="outerHTML"
        hx-on::after-request="if(event.detail.successful) this.reset();">
        <textarea name="body" rows="3" placeholder="Describe what you were doing when the problem (or the idea) occurred." required></textarea>
        <div class="dialog-buttons">
          <button class="btn btn-primary" type="submit">Send Error Report</button>
          <button class="btn" type="button" onclick="closePopup(this)">Don't Send</button>
        </div>
      </form>
      ${sent ? html`<p class="settings-saved">✅ Thank you for submitting an error report.</p>` : ''}
      <hr class="popup-divider">
      <div class="feedback-log-label">sent reports <span class="section-count">${entries.length}</span></div>
      ${entries.length ? html`<div class="feedback-list">
        ${entries.map((f) => html`
          <div class="feedback-entry">
            <div class="feedback-meta">
              <span class="feedback-from" style="color:${nameColor(f.display_name || f.name || 'anonymous')}">${f.display_name || f.name || 'anonymous'}</span>
              <span class="msn-time local-time" data-utc="${f.created_at}" data-fmt="datetime">${(f.created_at || '').slice(5, 16)}</span>
              ${f.page ? html`<span class="feedback-page" title="where they were when they filed it">${f.page}</span>` : ''}
            </div>
            <div class="feedback-text">${raw(msnify(f.body))}</div>
          </div>`)}
      </div>` : html`<p class="pick-empty">There are no reports in this view. Nothing has crashed and nobody has complained. Suspicious.</p>`}
    </div>`;
}

// The feedback window as a floating XP popup (start menu → send feedback).
feedback.get('/feedback/window', async (c) => {
    const entries = await feedbackEntries(c.env.DB);
    return c.html(xpPopup({
        title: 'Feedback Report',
        id: 'feedback',
        wide: true,
        body: feedbackBody(c.get('person'), entries),
    }));
});

// Full-page fallback for no-JS / direct navigation.
feedback.get('/feedback', async (c) => {
    const entries = await feedbackEntries(c.env.DB);
    const body = html`<div class="card"><h2 style="margin-top:0;">Feedback</h2>${feedbackBody(c.get('person'), entries, c.req.query('sent') === '1')}</div>`;
    return c.html(await renderPage(c, { title: 'feedback', body }));
});

// Anyone can file a report, signed in or not — feedback shouldn't have a bouncer.
feedback.post('/feedback', async (c) => {
    const db = c.env.DB;
    const person = c.get('person');
    const bodyParams = await c.req.parseBody();
    const text = (bodyParams.body || '').toString().trim();
    const htmx = c.req.header('HX-Request') === 'true';

    if (text) {
        let page = null;
        try { page = new URL(c.req.header('referer') || '').pathname; } catch (e) { /* no referer */ }
        const result = await db.prepare('INSERT INTO feedback (person_id, name, body, page) VALUES (?, ?, ?, ?)')
            .bind(person ? person.id : null, person ? person.display_name : 'anonymous', text, page).run();

        await logAction(c, {
            action: 'create', entityType: 'feedback', entityId: result.meta.last_row_id,
            summary: `${person ? person.display_name : 'someone'} sent feedback`,
        });
    }

    if (!htmx) return c.redirect('/feedback?sent=1');
    const entries = await feedbackEntries(db);
    return c.html(feedbackBody(person, entries, !!text));
});
