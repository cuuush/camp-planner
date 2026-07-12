import { html } from 'hono/html';
import { festNameFromPath } from './festival.js';
import { xpDialogPopup, xpCaptionBtns } from '../render/popup.js';

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

// The sign-in form, shown inside the modal. Submits via htmx back into the same
// overlay slot — so a "someone's already signed in as X" reply below can replace
// it in place instead of navigating to a separate screen.
export function modalFormMarkup(ctx) {
    return html`
    <div class="modal-backdrop" onclick="campSigninBackdrop(event, this)">
      <div class="modal-box xp-dialog">
        <div class="xp-dialog-title">
          <span class="xp-dialog-title-text">Sign In</span>
          ${xpCaptionBtns({ min: false, max: false, onClose: "document.getElementById('signin-modal-overlay').innerHTML=''" })}
        </div>
        <div class="xp-dialog-body">
          ${ctx.festName ? html`<p class="signin-fest-note">✔ Signing in will also add you to <b>${ctx.festName}</b>.</p>` : ''}
          <form hx-post="/signin" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
            ${hiddenFields(ctx)}
            <input type="text" name="name" class="signin-name-input" placeholder="Type your name" required autofocus>
            <div class="name-taken-notice"></div>
            <p class="signin-hint">To begin, type your name. No password is required. If someone else might use this name, choose one that is more identifiable.</p>
            <input type="email" name="email" placeholder="E-mail address (optional, for notifications)">
            <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">Sign In and Continue</button>
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
      <h2 style="margin-top:0;">Sign In</h2>
      ${ctx.festName ? html`<p class="signin-fest-note">✔ Signing in will also add you to <b>${ctx.festName}</b>.</p>` : ''}
      <form method="post" action="/signin">
        ${hiddenFields(ctx)}
        <input type="text" name="name" class="signin-name-input" placeholder="Type your name" required autofocus>
        <p class="signin-hint">To begin, type your name. No password is required. If someone else might use this name, choose one that is more identifiable.</p>
        <input type="email" name="email" placeholder="E-mail address (optional, for notifications)">
        <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">Sign In and Continue</button>
      </form>
    </div>`;
}

// Shown as a warning window stacked ON TOP of the sign-in dialog when the typed
// name is already taken: confirm it's really you (→ trust-based reclaim) or back
// out and pick another. Built on the reusable xpDialogPopup so it cascades over
// the modal like a real second window.
export function nameTakenWarning(reclaimName, ctx) {
    const vals = { name: reclaimName, next: ctx.next || '', expand: ctx.expandId || '', replay_path: ctx.replayPath || '', replay_body: ctx.replayBody || '' };
    return xpDialogPopup({
        title: 'Name Already in Use',
        id: 'name-taken',
        icon: 'warning',
        big: true,
        // While this is up, the sign-in form is stashed; dismissing (✕ or "Choose
        // Another") brings it back with whatever they'd typed still there.
        onClose: 'campRestoreSignin()',
        message: html`The name <b>${reclaimName}</b> is already in use. If this is you, click <b>Yes, That's Me</b> to sign in. If not, click <b>Choose Another</b> and pick a name that is more identifiable.`,
        buttons: html`
          <button class="btn" type="button" onclick="campRestoreSignin();closePopup(this)">Choose Another</button>
          <button class="btn btn-primary" type="button"
            hx-post="/signin/reclaim" hx-target="#signin-modal-overlay" hx-swap="innerHTML"
            hx-vals='${JSON.stringify(vals)}'>Yes, That's Me</button>`,
    });
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

    const festName = await festNameFromPath(c, next);
    return c.html(modalFormMarkup({ next, expandId, replayPath, replayBody, festName }));
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
