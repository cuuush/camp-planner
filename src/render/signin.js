import { html } from 'hono/html';

export function signinForm(prefillName = '', reclaim = null) {
    return html`
    <div class="card">
      <h2>sign in</h2>
      <p>just type your name, that's it. no password, no email required.</p>
      ${reclaim
            ? html`
        <div class="card unclaimed">
          <p>someone's already signed in as <b>${reclaim}</b> — is that you?</p>
          <form method="post" action="/signin/reclaim">
            <input type="hidden" name="name" value="${reclaim}">
            <button class="btn" type="submit">yes that's me</button>
          </form>
        </div>`
            : html`
        <form method="post" action="/signin">
          <label>your name: <input type="text" name="name" value="${prefillName}" required autofocus></label><br><br>
          <label>email <i>(only if u want email notifications)</i>: <input type="email" name="email"></label><br>
          <p style="font-size:0.85em;color:#aaa;">if u think there will be another person with your name, maybe pick something more identifiable haha</p>
          <button class="btn" type="submit">let's go</button>
        </form>`}
    </div>`;
}
