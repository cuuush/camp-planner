import { html } from 'hono/html';

const PASTEL_RAINBOW = ['#ff9aa2', '#ffb877', '#ffe066', '#a8e6b0', '#8fd9d0', '#8ec9f0', '#c9a8ea'];

export function rainbowText(text) {
    return html`${[...(text || '')].map((ch, i) => (ch === ' '
        ? ' '
        : html`<span style="color:${PASTEL_RAINBOW[i % PASTEL_RAINBOW.length]}">${ch}</span>`))}`;
}
