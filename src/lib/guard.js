import { html } from 'hono/html';
import { festNameFromPath } from './festival.js';
import { xpDialogPopup } from '../render/popup.js';

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
          <button type="button" class="xp-dialog-close" onclick="document.getElementById('signin-modal-overlay').innerHTML=''">✕</button>
        </div>
        <div class="xp-dialog-body">
          ${ctx.festName ? html`<p class="signin-fest-note">✔ signing in adds you to <b>${ctx.festName}</b>.</p>` : ''}
          <form hx-post="/signin" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
            ${hiddenFields(ctx)}
            <input type="text" name="name" class="signin-name-input" placeholder="your name" required autofocus>
            <div class="name-taken-notice"></div>
            <p class="signin-hint">takes 2 seconds, no password. if u think someone else might use this name, pick something more identifiable haha</p>
            <input type="email" name="email" placeholder="email (optional, just for notifications)">
            <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">sign in &amp; continue</button>
          </form>
        </div>
      </div>
    </div>`;
}

// Shown as a warning window stacked ON TOP of the sign-in dialog when the typed
// name is already taken: confirm it's really you (→ trust-based reclaim) or back
// out and pick another. Built on the reusable xpDialogPopup so it cascades over
// the modal like a real second window.
export function nameTakenWarning(reclaimName, ctx) {
    const vals = { name: reclaimName, next: ctx.next || '', expand: ctx.expandId || '', replay_path: ctx.replayPath || '', replay_body: ctx.replayBody || '' };
    return xpDialogPopup({
        title: 'Name already in use',
        id: 'name-taken',
        icon: '/notify.png',
        big: true,
        // While this is up, the sign-in form is stashed; dismissing (✕ or "pick
        // another") brings it back with whatever they'd typed still there.
        onClose: 'campRestoreSignin()',
        message: html`<b>${reclaimName}</b> is already signed up. If that's you, go ahead and sign in — otherwise close this and pick a more specific name.`,
        buttons: html`
          <button class="btn" type="button" onclick="campRestoreSignin();closePopup(this)">pick another</button>
          <button class="btn btn-primary" type="button"
            hx-post="/signin/reclaim" hx-target="#signin-modal-overlay" hx-swap="innerHTML"
            hx-vals='${JSON.stringify(vals)}'>yep, that's me</button>`,
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
