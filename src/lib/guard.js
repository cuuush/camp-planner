import { html } from 'hono/html';
import { festNameFromPath, festPeopleFromPath } from './festival.js';
import { xpCaptionBtns } from '../render/popup.js';

export function needsSignin(c) {
    return !c.get('person');
}

function hiddenFields({ next, expandId, replayPath, replayBody }) {
    return html`
      <input type="hidden" name="next" value="${next}">
      <input type="hidden" name="expand" value="${expandId || ''}">
      <input type="hidden" name="replay_path" value="${replayPath || ''}">
      <input type="hidden" name="replay_body" value="${replayBody || ''}">`;
}

// The name field, plus XP's Welcome-screen conceit: the fest's existing names as a
// pick list under the box, from the first letter typed. The names ship WITH the page
// in a data attribute and are filtered locally (campSigninMatches) — no round trip,
// so the list is there on that first keystroke. That matters because the
// overwhelmingly common sign-in is a regular who lost their session, and a typo
// doesn't fail loudly here — it quietly opens a second account (normalized_name IS
// the credential), which then has to be merged by hand. Picking an existing name is
// therefore the INTENDED path, which is why nothing here warns you off one. The list
// (festPeopleFromPath) also includes manually-added placeholders — picking one signs
// in for real and absorbs the placeholder automatically.
function nameField(ctx) {
    const names = ctx.festPeople && ctx.festPeople.length ? ctx.festPeople : null;
    return html`
    <div class="signin-namebox">
      <input type="text" name="name" class="signin-name-input" placeholder="Type your user name"
        autocomplete="off" autocapitalize="words" spellcheck="false" required autofocus
        ${names ? html`data-names="${JSON.stringify(names)}"` : ''}>
      ${names ? html`<div class="signin-suggest" hidden></div>` : ''}
    </div>
    <p class="signin-hint">To begin, type your user name. No password is required.</p>`;
}

// The sign-in form, shown inside the modal. Submits via htmx back into the same
// overlay slot — so a "someone's already signed in as X" reply below can replace
// it in place instead of navigating to a separate screen.
export function modalFormMarkup(ctx) {
    return html`
    <div class="modal-backdrop" onclick="campSigninBackdrop(event, this)">
      <div class="modal-box xp-dialog">
        <div class="xp-dialog-title">
          <span class="xp-dialog-title-text">Log On to ${ctx.festName || 'Camp Planner'}</span>
          ${xpCaptionBtns({ min: false, max: false, onClose: "document.getElementById('signin-modal-overlay').innerHTML=''" })}
        </div>
        <div class="xp-dialog-body">
          ${ctx.festName ? html`<p class="signin-fest-note">✔ Logging on also adds you to <b>${ctx.festName}</b>.</p>` : ''}
          <form hx-post="/signin" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
            ${hiddenFields(ctx)}
            ${nameField(ctx)}
            <input type="email" name="email" placeholder="E-mail address (optional)">
            <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">Log On</button>
          </form>
        </div>
      </div>
    </div>`;
}

// The standalone, full-page sign-in form — what you get by actually navigating to
// /signin (e.g. a no-JS fallback, or a plain form post that needed a login first).
// Unlike modalFormMarkup this is a REAL form (method/action, no htmx overlay), so
// it submits and works with or without JS; POST /signin's non-htmx branch signs you
// in and redirects. Keep it plain — no floating window, no stash/restore dance.
export function signinPageMarkup(ctx) {
    return html`
    <div class="card signin-page">
      <h2 style="margin-top:0;"><img class="signin-logon-ico" src="/xp/logon.png" alt="">Log On to ${ctx.festName || 'Camp Planner'}</h2>
      ${ctx.festName ? html`<p class="signin-fest-note">✔ Logging on also adds you to <b>${ctx.festName}</b>.</p>` : ''}
      <form method="post" action="/signin">
        ${hiddenFields(ctx)}
        ${nameField(ctx)}
        <input type="email" name="email" placeholder="E-mail address (optional)">
        <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">Log On</button>
      </form>
    </div>`;
}

function captureReplay(c) {
    return {
        next: c.req.header('referer') || '/',
        replayPath: c.req.path,
    };
}

// Used by htmx-driven mutation endpoints: retarget the swap into a full-screen
// sign-in modal instead of clobbering whatever fragment the form would've updated.
// Captures the exact request (path + body) so it can be replayed for real once
// they're signed in — the action they were trying to do just... happens.
export async function signinModalResponse(c, { expandId } = {}) {
    c.header('HX-Retarget', '#signin-modal-overlay');
    c.header('HX-Reswap', 'innerHTML');

    const { next, replayPath } = captureReplay(c);
    let replayBody = '';
    try {
        replayBody = await c.req.raw.clone().text();
    } catch (e) { /* no body to replay */ }

    const [festName, festPeople] = await Promise.all([
        festNameFromPath(c, next),
        festPeopleFromPath(c, next),
    ]);
    return c.html(modalFormMarkup({ next, expandId, replayPath, replayBody, festName, festPeople }));
}

// Used by plain (non-htmx) form posts that mutate state — full navigation to a
// dedicated sign-in page, replaying the original submission once they're in.
export async function signinRedirect(c) {
    const { next, replayPath } = captureReplay(c);
    let replayBody = '';
    try {
        replayBody = await c.req.raw.clone().text();
    } catch (e) { /* no body to replay */ }

    const params = new URLSearchParams({ next, replay_path: replayPath, replay_body: replayBody });
    return c.redirect(`/signin?${params.toString()}`);
}
