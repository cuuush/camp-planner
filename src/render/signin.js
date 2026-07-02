import { html } from 'hono/html';

export function signinForm(prefillName = '', reclaim = null, ctx = {}) {
    const { next = '', expandId = '', replayPath = '', replayBody = '' } = ctx;
    const hiddenFields = html`
      <input type="hidden" name="next" value="${next}">
      <input type="hidden" name="expand" value="${expandId}">
      <input type="hidden" name="replay_path" value="${replayPath}">
      <input type="hidden" name="replay_body" value="${replayBody}">`;

    return html`
    <div class="xp-dialog signin-dialog">
      <div class="xp-dialog-title">
        <span class="xp-dialog-title-text">Camp Planner — Sign In</span>
      </div>
      <div class="xp-dialog-body">
        <form method="post" action="/signin">
          ${hiddenFields}
          <input type="text" name="name" value="${prefillName}" class="signin-name-input" placeholder="your name" required autofocus>
          <div class="name-taken-notice"></div>
          <p class="signin-hint">takes 2 seconds, no password. if u think there will be another person with your name, maybe pick something more identifiable haha</p>
          <input type="email" name="email" placeholder="email (optional, just for notifications)">
          <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">let's go</button>
        </form>
        <p style="font-size:0.85em; color:#5b93a3; margin-top:16px;">
          <b>what does the email actually do?</b> that's it, just notifications — someone pledges or comments on
          something you added, grabs/leaves a seat in your car, etc. we never show it to anyone else, never email
          you about your own actions, and there's an unsubscribe link on every email. totally optional.
        </p>
      </div>
    </div>`;
}
