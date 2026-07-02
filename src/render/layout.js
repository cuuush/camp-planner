import { html, raw } from 'hono/html';
import { PIXMOJI_COVERED_RANGES } from './pixmoji-coverage.js';

const RETRO_CSS = `
  * { box-sizing: border-box; }
  /* The goofy display font. Real Comic Sans on Windows/macOS (both ship it),
     Comic Neue web font on iOS/Android (they don't), then native fallbacks.
     Without this, iOS falls through to 'cursive' = Snell Roundhand (a formal
     script), which looks nothing like the intended vibe. */
  :root { --fun-font: 'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', cursive; }
  /* UnifontEX — a bitmap/pixel font with full emoji coverage. We render EVERY
     emoji through it (via .pixmoji spans the client wraps around emoji) so they
     look like chunky 8-bit pixel glyphs, matching the XP/MSN vibe. Only the
     emoji get it; regular Tahoma text stays crisp. Mono only (no color). */
  @font-face {
    font-family: 'UnifontExMono';
    src: url('https://cdn.jsdelivr.net/gh/stgiga/UnifontEX/UnifontExMono.woff2') format('woff2');
    font-display: swap;
  }
  /* Gap-filler: emoji-only subset of GNU Unifont 16 (self-hosted, ~50KB) that
     covers every 2019+ emoji UnifontEX (Unicode <= 11) lacks — mirror, wood,
     chair, coin, … Same pixel style, so the whole set stays consistent. */
  @font-face {
    font-family: 'UnifontEmoji16';
    src: url('/fonts/unifont-emoji16.woff2') format('woff2');
    font-display: swap;
  }
  .pixmoji {
    font-family: 'UnifontExMono', 'UnifontEmoji16', sans-serif;
    font-weight: normal; font-style: normal; line-height: 1;
    -webkit-font-smoothing: none; -moz-osx-font-smoothing: unset; font-smooth: never;
    /* No-character way to ask for the pixel glyph over the system color emoji. */
    font-variant-emoji: text;
  }
  body {
    background: #5b8f3a;
    color: #000;
    font-family: Tahoma, Verdana, Arial, sans-serif;
    margin: 0;
    min-height: 100vh;
  }
  /* The "Bliss" XP wallpaper lives on a fixed full-viewport layer rather than
     background-attachment:fixed. iOS Safari sizes a fixed background to the
     whole document height (so it blows up huge on long pages like the stuff
     tab); a position:fixed element is always viewport-sized and renders right. */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -1;
    background: #5b8f3a url('/xp-bliss.jpg') center center / cover no-repeat;
  }
  a { color: #0000ee; text-decoration: underline; }
  a:visited { color: #551a8b; }
  /* News ticker styled like an XP status/notification strip: a Luna blue caption
     gradient band with a bright top bevel, a little "Start"-style News pill pinned
     at the left, and the headlines scrolling in white Tahoma on the inset track. */
  .marquee-wrap {
    position: relative; display: flex; align-items: stretch;
    background: linear-gradient(180deg,#3d95ff 0%,#1e63e8 8%,#1a52d0 45%,#1749c4 55%,#1e63e8 92%,#3d95ff 100%);
    border-top: 1px solid #6aa4ff; border-bottom: 1px solid #0a246a;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 1px 3px rgba(0,0,0,0.3);
    overflow: hidden; white-space: nowrap;
  }
  /* A flat darker-navy label segment with a divider — reads as a ticker heading,
     not the green Start button. */
  .marquee-badge {
    flex: 0 0 auto; display: flex; align-items: center; gap: 5px;
    padding: 4px 13px 4px 11px; font-family: Tahoma, sans-serif; font-weight: bold;
    font-size: 0.82em; color: #dfeaff; letter-spacing: 0.3px; text-transform: uppercase;
    text-shadow: 1px 1px 1px rgba(0,0,30,0.6);
    background: linear-gradient(180deg,#123f9e 0%,#0c2f80 55%,#0a2872 100%);
    border-right: 1px solid rgba(0,0,20,0.5);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 1px 0 0 rgba(120,160,230,0.4);
  }
  .marquee-track { flex: 1 1 auto; overflow: hidden; align-self: center; }
  .marquee { display: inline-block; padding-left: 100%; animation-name: marquee; animation-timing-function: linear; animation-iteration-count: infinite; color: #fff; font-weight: bold; font-family: Tahoma, Verdana, sans-serif; text-shadow: 1px 1px 1px rgba(0,0,30,0.55); font-size: 0.86em; }
  @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-100%); } }
  /* Silver "Explorer" command bar rather than a big slab of taskbar blue. */
  header.site {
    background: linear-gradient(180deg,#faf9f4 0%,#eeece0 48%,#e4e1d1 52%,#f1efe4 100%);
    border-bottom: 1px solid #9a9784;
    box-shadow: 0 1px 0 #fff inset, 0 2px 5px rgba(0,0,0,0.25);
    padding: 8px 14px; color: #1b1b17;
  }
  .fest-picker { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .fest-picker a { color: #0a3d91; }
  .fest-picker b { color: #0a246a; }
  .fest-picker select, .fest-picker a.button, button, input[type=submit] { font-family: inherit; }
  /* Page header: an XP "Explorer bar" title band — a silver-to-blue Luna gradient
     panel with a bright top bevel and the fest name in blue Tahoma, like the header
     of a Control Panel / My Computer view. (No more Web-1.0 orange gradient text.) */
  h1.title {
    max-width: 900px; width: calc(100% - 44px); margin: 16px auto 0;
    display: flex; align-items: center; gap: 10px;
    text-align: left; font-size: 1.35em; letter-spacing: 0; font-weight: bold;
    font-family: Tahoma, Verdana, sans-serif; color: #0a246a;
    padding: 8px 16px; border-radius: 6px;
    background: linear-gradient(180deg,#fbfdff 0%,#eaf0fb 46%,#d7e3f7 54%,#e9f0fb 100%);
    border: 1px solid #7a9bd0;
    box-shadow: inset 0 1px 0 #fff, 0 2px 5px rgba(0,0,0,0.22);
  }
  .title-icon { font-size: 1.15em; line-height: 1; }
  .title-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Rover the Search Companion: an authentic XP touch. The tip sits in a blue
     rounded speech box (light-blue fill, white outline) and the dog sits just
     below it, with a downward tail on the box's lower-left pointing at the dog. */
  .dog-assistant {
    max-width: 900px; width: calc(100% - 44px); margin: 12px auto 0;
    display: flex; flex-direction: column; align-items: flex-start; gap: 0;
  }
  .dog-bubble {
    position: relative; align-self: stretch; min-width: 0;
    background: #d3e6fb;                 /* light blue inside */
    border: 2px solid #ffffff;           /* white outline */
    border-radius: 12px;
    padding: 11px 15px; font-size: 0.9em; color: #14396e; line-height: 1.42;
    box-shadow: 0 3px 7px rgba(0,0,20,0.28);
  }
  /* Speech-bubble tail: a real triangle hanging from the box's lower-left. Its two
     top points A,B sit on the box's bottom edge, the tip C drops below and toward B,
     aimed at the dog below. The two pseudo-elements share one frame whose top 3px
     overlap into the box. The white FILL... wait: the light-blue FILL triangle (in
     front) is drawn so it covers the box's bottom border between A and B — so the
     white outline appears to BREAK there and continue down the two slanted sides,
     while the white outline triangle behind supplies those slanted edges. */
  .dog-bubble::before, .dog-bubble::after {
    content: ''; position: absolute; left: 22px; bottom: -34px; width: 28px; height: 37px;
  }
  /* white outline triangle (behind): A(2,3) B(19.6,3), tip C(18,35) — a long tail
     with B pulled left so the right edge is near-vertical (like XP's Rover bubble). */
  .dog-bubble::before { background: #ffffff; clip-path: polygon(2px 3px, 19.6px 3px, 18px 35px); }
  /* light-blue fill (front): the outline triangle offset inward a true ~1px
     PERPENDICULAR to the A→C and C→B edges (not a fixed x/y shift), so the white
     border stays a constant 1px width all the way down to the tip. Its top sits at
     y=1 (up inside the box) to hide the box's bottom border between A and B. */
  .dog-bubble::after { background: #d3e6fb; clip-path: polygon(2.12px 1px, 18.7px 1px, 17.19px 31.14px); }
  .dog-img {
    width: 66px; height: auto; margin: 30px 0 0 34px; image-rendering: auto;
    filter: drop-shadow(1px 2px 2px rgba(0,0,0,0.3));
  }
  .dog-bubble b { color: #0a246a; }
  .dog-bubble a { color: #0a3d91; font-weight: bold; }
  .dog-title { font-weight: bold; color: #0a246a; display: block; margin-bottom: 2px; }
  @media (max-width: 600px) { .dog-img { width: 52px; } .dog-bubble { font-size: 0.85em; } }
  /* XP tab control: inactive tabs sit slightly lower and behind the active one,
     which lifts up and merges with the page below it. */
  nav.tabs { display: flex; padding: 6px 0 0; gap: 2px; border-bottom: 1px solid #919b9c; margin: 0 0 12px; align-items: flex-end; }
  nav.tabs a {
    flex: 1; text-align: center; padding: 6px 4px; text-decoration: none; color: #202020; font-weight: normal;
    background: linear-gradient(180deg,#fbfbf8 0%,#eceadd 55%,#e2dfce 100%);
    border: 1px solid #919b9c; border-bottom: none; border-radius: 4px 4px 0 0;
    position: relative; top: 1px; font-size: 0.85em;
  }
  nav.tabs a:hover { background: linear-gradient(180deg,#ffffff 0%,#f4f2e6 100%); }
  nav.tabs a.active {
    background: #fffdf5; color: #000; font-weight: bold;
    border-color: #919b9c; top: 0; padding-top: 9px; margin-bottom: -1px; z-index: 2;
  }
  main { max-width: 900px; margin: 0 auto; padding: 12px; min-height: 60vh; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; background: #fff; }
  /* Wide grids (the ppl checklist) scroll inside their own box instead of
     shoving the whole page off the side of the screen. */
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; border: 1px solid #7e9dc4; border-radius: 4px; }
  .table-scroll table { width: auto; min-width: 100%; border: none; }
  .table-scroll th, .table-scroll td { white-space: nowrap; }
  /* Audit log: keep timestamp/name narrow but let the "what" summary wrap so the
     table doesn't run off a phone screen. */
  .log-table { font-size: 0.85em; }
  .log-table .log-when { color: #555; }
  .log-table .log-what { white-space: normal; min-width: 150px; }
  td, th { border: 1px solid #7e9dc4; padding: 6px 8px; }
  th { background: linear-gradient(180deg,#c1d7f2,#9cbde4); color: #0a246a; }
  .btn, button, input[type=submit] {
    /* Authentic Luna push button: dark-blue hairline border, rounded 3px,
       pale vertical gradient with a bright top highlight. */
    background: linear-gradient(180deg,#fdfeff 0%,#f2f2ec 45%,#ebebdf 52%,#f6f5ee 90%,#ffffff 100%);
    border: 1px solid #003c74;
    color: #000;
    padding: 4px 15px;
    cursor: pointer;
    font-weight: normal;
    font-size: 0.9em;
    line-height: 1.4;
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px #fff, inset 0 -6px 6px -6px rgba(0,60,116,0.25);
    text-decoration: none;
  }
  /* Luna hot-track: a soft amber glow on hover, exactly like a moused-over XP button. */
  .btn:hover, button:hover, input[type=submit]:hover {
    border-color: #e08a1e;
    box-shadow: inset 0 0 0 1px #fff, 0 0 4px 1px rgba(255,177,40,0.75);
    background: linear-gradient(180deg,#fffefb 0%,#fdf6e4 45%,#fbeecb 52%,#fdf6e0 90%,#ffffff 100%);
  }
  .btn:active, button:active, input[type=submit]:active {
    background: linear-gradient(180deg,#e3e3da 0%,#eceadf 60%,#f6f5ee 100%);
    box-shadow: inset 1px 1px 2px rgba(0,0,0,0.28);
  }
  .btn:focus-visible, button:focus-visible, input[type=submit]:focus-visible {
    outline: 1px dotted #4a4a3c; outline-offset: -4px;
  }
  .rainbow { font-weight: bold; }
  .card {
    background: #ffffff;
    border: 1px solid #a0aebf;
    border-radius: 3px;
    margin: 10px 0;
    padding: 10px 14px;
    box-shadow: inset 0 0 0 1px #fff, 1px 1px 3px rgba(0,0,0,0.28);
  }
  /* Unclaimed items no longer get a loud red outline — they look like any other card. */
  .unclaimed { border-color: #a0aebf; box-shadow: inset 0 0 0 1px #fff, 1px 1px 3px rgba(0,0,0,0.28); }
  /* Land here from a "my list" link → the card flashes so you spot it. */
  .card:target { scroll-margin-top: 14px; animation: card-target-flash 1.8s ease; }
  @keyframes card-target-flash {
    0% { box-shadow: 0 0 0 3px #ffd54a, 0 0 14px 3px rgba(255,183,0,0.85); }
    70% { box-shadow: 0 0 0 3px #ffd54a, 0 0 14px 3px rgba(255,183,0,0.85); }
    100% { box-shadow: 2px 2px 5px rgba(0,0,0,0.25); }
  }
  .mine-row { padding: 3px 0; }
  .mine-link { font-weight: bold; }
  /* Classic Luna progress control: white sunken trough with a padded interior... */
  .progress-bar { background: #fff; border: 1px solid #7f9db9; height: 15px; width: 100%; border-radius: 0; overflow: hidden; padding: 2px; box-shadow: inset 1px 1px 1px rgba(0,0,0,0.12); }
  /* ...filled by glossy green blocks separated by thin gaps, like the XP file-copy bar. */
  .progress-fill {
    height: 100%;
    background-color: #45d13d;
    background-image:
      linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.15) 45%, rgba(0,0,0,0.12) 55%, rgba(255,255,255,0.30) 100%),
      repeating-linear-gradient(90deg, rgba(255,255,255,0) 0 6px, rgba(255,255,255,0.9) 6px 8px);
  }
  .divider { text-align: center; color: #0a246a; margin: 14px 0; font-weight: bold; font-family: var(--fun-font); }
  footer.site { background: linear-gradient(180deg,#1941d6,#0a246a); color: #dbe8ff; padding: 14px; text-align: center; margin-top: 24px; border-top: 2px solid #0a246a; }
  footer.site a { color: #ffe94d; }
  .badge-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin: 10px 0; }
  .badge-row .badge { width: 88px; height: 31px; background: #fff; border: 1px solid #000; display: flex; align-items: center; justify-content: center; font-size: 8px; color: #000; text-align: center; font-family: Tahoma, sans-serif; }
  .webring { margin-top: 10px; font-size: 0.9em; }
  .hitcounter { font-family: 'Courier New', monospace; background: #000; color: #00ff2a; padding: 2px 8px; border: 2px inset #888; letter-spacing: 2px; }
  input[type=text], input[type=number], input[type=email], select, textarea {
    background: #fff; border: 1px solid #7f9db9; padding: 5px 8px; font-family: inherit; border-radius: 0; color: #000;
    box-shadow: inset 1px 1px 1px rgba(0,0,0,0.12);
    font-size: 16px; /* iOS Safari zooms in on focus for anything smaller than 16px */
  }
  input[type=text]:focus, input[type=number]:focus, input[type=email]:focus, select:focus, textarea:focus {
    outline: none; border-color: #5a8fd6;
    box-shadow: inset 1px 1px 1px rgba(0,0,0,0.12), 0 0 3px 1px rgba(90,143,214,0.7);
  }
  .comment { border-top: 1px dashed #7e9dc4; padding: 5px 0; font-size: 0.85em; }

  /* ppl tab: a compact, read-only roster of who's coming (+ their prep status). */
  .ppl-count { font-weight: bold; color: #0a246a; margin: 4px 0 10px; }
  .ppl-list { display: flex; flex-direction: column; gap: 4px; }
  .ppl-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
    background: #fff; border: 1px solid #c3d2ec; border-radius: 3px; padding: 5px 10px;
  }
  .ppl-name { font-weight: bold; }
  .ppl-tasks { display: flex; flex-wrap: wrap; gap: 3px 10px; margin-left: auto; }
  .ppl-task { font-size: 0.8em; color: #8a8a7a; white-space: nowrap; }
  .ppl-task.done { color: #1a7a1a; }
  @media (max-width: 600px) { nav.tabs a { font-size: 0.8em; padding: 8px 2px; } h1.title { font-size: 1.1em; padding: 7px 12px; } }

  #signin-modal-overlay:empty { display: none; }
  #signin-modal-overlay:not(:empty) {
    position: fixed; inset: 0; z-index: 999;
  }
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 1000; background: rgba(40,90,110,0.45);
    display: flex; align-items: center; justify-content: center; padding: 16px;
    backdrop-filter: blur(2px);
  }
  /* Modals AND the sign-in page share one look: an authentic XP dialog window —
     blue Luna caption bar + red close button, thin blue frame, gray dialog face. */
  .modal-box, .xp-dialog {
    position: relative;
    background: #0831d9;               /* the blue window frame */
    border-radius: 8px 8px 6px 6px;
    padding: 0 3px 3px;
    max-width: 420px; width: 100%;
    box-shadow: 0 12px 44px rgba(0,0,0,0.55);
  }
  .xp-dialog.signin-dialog { margin: 18px auto; }
  .xp-dialog-title {
    height: 28px; display: flex; align-items: center; gap: 6px;
    padding: 0 4px 0 9px; border-radius: 6px 6px 0 0;
    color: #fff; font-weight: bold; font-family: Tahoma, sans-serif; font-size: 0.9em;
    text-shadow: 1px 1px 2px rgba(0,0,20,0.55);
    background: linear-gradient(180deg,#0997ff 0%,#0053ee 8%,#0050ee 40%,#0165ff 88%,#0165ff 93%,#0997ff 95%,#0165ff 100%);
  }
  .xp-dialog-title-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .xp-dialog-close {
    width: 21px; height: 21px; flex-shrink: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,0.9); border-radius: 3px;
    color: #fff; font-size: 11px; font-weight: bold; cursor: pointer;
    text-shadow: 0 1px 1px rgba(0,0,0,0.4);
    background: linear-gradient(180deg,#f9b38c 0%,#e0632f 8%,#e14f28 45%,#d0330f 100%);
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.55), inset 0 -3px 4px rgba(0,0,60,0.35);
  }
  .xp-dialog-body { background: #ece9d8; padding: 18px; border-radius: 0 0 4px 4px; }
  .xp-dialog-body > h2:first-child, .xp-dialog-body > p:first-child { margin-top: 0; }
  .xp-dialog-body h2 { color: #0a246a; font-family: var(--fun-font); }
  .modal-box form, .card form { display: block; }
  .xp-dialog-body input[type=text], .xp-dialog-body input[type=email],
  .card input[type=email],
  .signin-name-input {
    display: block; width: 100%; box-sizing: border-box;
  }
  .signin-name-input {
    font-size: 1.3em !important;
    padding: 14px !important;
    margin-top: 6px;
  }
  .modal-box input[type=email], .card input[type=email] {
    margin-top: 10px;
  }
  .signin-hint { font-size: 0.8em; color: #4a4a3c; margin: 8px 0 0; }
  .name-taken-notice { font-size: 0.8em; color: #b85c00; margin-top: 6px; }
  .name-taken-notice:empty { display: none; }

  .vote-thumb {
    background: none; border: 1px solid transparent; box-shadow: none; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; line-height: 1;
    padding: 4px 6px; font-size: 1.8em; flex-shrink: 0; color: inherit; border-radius: 4px;
  }
  .vote-thumb:hover { background: rgba(49,106,197,0.08); border-color: #a9c3ea; box-shadow: none; }
  .vote-thumb .vote-count { font-size: 0.4em; color: #0a246a; font-weight: bold; margin-top: 2px; }
  /* Voted = an XP toolbar toggle in its "pressed/on" state: sunken light-blue face,
     and the thumb glyph filled blue (color tints the mono pixel glyph). */
  .vote-thumb.voted {
    color: #1c5fbf;
    background: linear-gradient(180deg,#cfe0f7,#aecbec);
    border: 1px solid #5a8fd6;
    box-shadow: inset 1px 1px 2px rgba(0,0,60,0.28);
  }
  .vote-thumb.voted:hover { background: linear-gradient(180deg,#d9e8fb,#bcd4f0); border-color: #5a8fd6; }
  .vote-thumb.voted .vote-count { color: #0a246a; }
  @keyframes vote-pop { 0% { transform: scale(1); } 45% { transform: scale(1.5); } 100% { transform: scale(1); } }
  .vote-thumb.pop { animation: vote-pop 0.35s ease; }
  @keyframes confetti-burst {
    0% { transform: translate(0,0) rotate(0deg); opacity: 1; }
    100% { transform: var(--confetti-end) rotate(var(--confetti-spin)); opacity: 0; }
  }
  .confetti-piece {
    position: fixed; pointer-events: none; z-index: 9999;
    animation: confetti-burst 0.7s ease-out forwards;
  }

  #toast:empty { display: none; }
  /* Toast styled like an XP balloon notification — a pale Luna panel with a blue
     hairline border and blue bold text, not an amber pill. */
  #toast {
    position: fixed; top: 76px; left: 50%; transform: translateX(-50%);
    z-index: 1000; pointer-events: none;
    background: linear-gradient(180deg,#ffffff 0%,#eef3fc 100%);
    color: #0a3d91; font-weight: bold;
    border: 1px solid #3c7fb1; border-radius: 5px;
    padding: 8px 22px;
    box-shadow: inset 0 0 0 1px #fff, 0 6px 18px rgba(0,0,40,0.35);
    animation: toast-inout 2.6s ease forwards;
    white-space: nowrap;
  }
  @keyframes toast-inout {
    0% { opacity: 0; transform: translateX(-50%) translateY(-12px); }
    12% { opacity: 1; transform: translateX(-50%) translateY(0); }
    82% { opacity: 1; }
    100% { opacity: 0; transform: translateX(-50%) translateY(-12px); }
  }

  .edit-toggle summary.btn-like {
    display: inline-flex; align-items: center; justify-content: center; list-style: none; cursor: pointer;
    margin: 0;
  }
  .edit-toggle summary.btn-like::-webkit-details-marker { display: none; }
  .edit-toggle summary.btn-like::marker { content: ''; }

  /* --- item card: collapsed by default, click the header to reveal actions --- */
  .item-details { }
  .item-summary {
    display: block; cursor: pointer; list-style: none;
    margin: -2px -4px; padding: 2px 4px; border-radius: 3px;
  }
  .item-summary::-webkit-details-marker { display: none; }
  .item-summary::marker { content: ''; }
  .item-summary:hover { background: rgba(49,106,197,0.06); }
  .item-top-row { display: flex; align-items: center; gap: 12px; }
  .item-emoji { font-size: 2.6em; line-height: 1; width: 56px; text-align: center; flex-shrink: 0; }
  .item-headline { flex: 1; min-width: 0; }
  .item-name { font-size: 1.25em; font-weight: bold; }
  .item-description { font-size: 0.85em; color: #444; margin: 2px 0 4px; }
  .item-tally { font-size: 0.85em; color: #4a8697; }
  .tally-covered { color: #1a7a1a; font-weight: bold; }

  /* Revealed action area, separated from the header by an XP etched rule. */
  .item-actions {
    margin-top: 12px; padding-top: 13px;
    border-top: 1px solid #d5d2c4; box-shadow: inset 0 1px 0 #ffffff;
    display: flex; flex-direction: column; gap: 10px;
  }
  /* Desktop: pledge + edit + chat button all share one row (pledge widest).
     Mobile: pledge+edit on row 1, chat button full-width on row 2. */
  .action-buttons { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
  .action-buttons > .btn-primary { flex: 2 1 0; min-width: 0; margin: 0; }
  .action-buttons > .edit-toggle { flex: 1 1 0; min-width: 0; margin: 0; }
  .edit-toggle > summary.btn-like { width: 100%; box-sizing: border-box; justify-content: center; text-align: center; }
  /* Only stretch the CLOSED edit button to match the pledge button's height. When
     OPEN it must stay auto-height, or height:100% balloons it to the whole panel. */
  .action-buttons > .edit-toggle:not([open]) > summary.btn-like { height: 100%; }
  /* When OPEN, the edit button shrinks back to its natural size and sits at the left
     of its row — only the edit panel below spans full width, not the button. */
  .action-buttons > .edit-toggle[open] > summary.btn-like { width: auto; }
  /* Collapsed chat = a button sitting to the right of edit, stretched to match. */
  .action-buttons > .msn-chat { margin: 0; }
  .action-buttons > .msn-chat:not([open]) { flex: 1.5 1 auto; align-self: stretch; display: flex; }
  .action-buttons > .msn-chat:not([open]) > summary.msn-titlebar { flex: 1; }
  /* When edit is open, "i'll bring this" takes the whole first row and the edit
     panel drops to its own full-width row below it. Open chat likewise gets a full row. */
  .action-buttons:has(.edit-toggle[open]) > .btn-primary { flex-basis: 100%; }
  .action-buttons > .edit-toggle[open] { flex-basis: 100%; order: 4; }
  .action-buttons > .msn-chat[open] { flex-basis: 100%; order: 5; }
  @media (max-width: 600px) {
    /* Chat button drops to its own full-width row BELOW pledge+edit. pledge/edit
       need a non-zero basis here, otherwise 0 + 0 + 100% all fit on one line and
       the chat gets squished onto the row instead of wrapping under it. */
    .action-buttons > .btn-primary { flex: 2 1 auto; }
    .action-buttons > .edit-toggle { flex: 1 1 auto; }
    .action-buttons > .msn-chat:not([open]) { flex: 1 0 100%; }
  }
  .withdraw-form { margin: 0; }
  .withdraw-form > .btn { width: 100%; justify-content: center; text-align: center; }

  /* Cars reuse the item action-buttons row: the seat button sits in the "pledge"
     slot, then edit, then the chat button — same flex behaviour. */
  .action-buttons > .car-seat-form { flex: 2 1 0; min-width: 0; margin: 0; display: flex; }
  .action-buttons > .car-seat-form > .btn { width: 100%; justify-content: center; text-align: center; }
  .action-buttons:has(.edit-toggle[open]) > .car-seat-form { flex-basis: 100%; }
  .car-riders { font-size: 0.9em; color: #333; margin: 0 0 4px; }
  .post-car-summary { cursor: pointer; font-family: var(--fun-font); color: #0a246a; padding: 2px 0; }
  @media (max-width: 600px) { .action-buttons > .car-seat-form { flex: 2 1 auto; } }

  /* Proper Windows default button: the same Luna chrome as a normal button,
     but emphasized as the default action with a blue highlight ring + bold
     label — not a coloured "Start button". */
  .btn-primary {
    border-color: #3c7fb1; font-weight: bold; color: #0b2f5c;
    box-shadow: inset 0 0 0 1px #cfe4fb, inset 0 -6px 6px -6px rgba(0,60,116,0.25), 0 0 2px 1px rgba(60,127,177,0.5);
  }
  .btn-primary:hover {
    border-color: #3c7fb1;
    box-shadow: inset 0 0 0 1px #cfe4fb, 0 0 4px 1px rgba(255,177,40,0.7);
  }
  /* Delete stays a plain Luna button (Windows doesn't colour destructive
     buttons); just a red label so it reads as the dangerous one. */
  .btn-danger { color: #9a1616; }

  /* An XP dialog: a normal-sized field inline with its unit, then a button bar
     pinned bottom-right with fixed-width buttons — not a full-width mega input. */
  /* Pledge dialog laid out like a real XP question box: the blue "?" icon on the
     left, and to its right the prompt sitting just above a full-width field, with
     the label nudged in ~2 characters (like XP dialog labels). */
  /* Icon bottom-aligns with the field so the "?" sits level with the input row,
     not floated up by the label above it. */
  .pledge-prompt { display: flex; align-items: flex-end; gap: 12px; margin-top: 2px; }
  .xp-dialog-icon { width: 32px; height: 32px; flex-shrink: 0; margin-bottom: 2px; }
  .pledge-field-col { flex: 1; min-width: 0; }
  .pledge-label { display: block; margin: 2px 0 5px 2ch; font-size: 0.85em; color: #1a1a1a; }
  .pledge-input-row { display: flex; align-items: center; gap: 8px; }
  /* A normal XP text field — not a giant bold display input. 16px keeps iOS from
     zooming on focus; that's as small as we go. */
  .pledge-modal-input {
    flex: 1 1 auto; width: 100%; min-width: 0;
    font-size: 16px !important; text-align: left; font-weight: normal;
    padding: 5px 8px !important;
  }
  .pledge-unit { flex-shrink: 0; color: #333; }
  .dialog-buttons {
    display: flex; justify-content: flex-end; gap: 8px;
    margin-top: 20px;
  }
  .dialog-buttons .btn { min-width: 82px; text-align: center; }

  /* Edit is a proper little XP dialog: a group-box face, right-aligned field
     labels lined up in a column, and an OK/Cancel-style button bar at the
     bottom — instead of a loose pile of inputs. */
  .edit-panel {
    margin-top: 10px; padding: 12px 14px;
    border: 1px solid #a0aebf; border-radius: 3px;
    background: #f1efe6; box-shadow: inset 0 0 0 1px #fff;
    display: flex; flex-direction: column; gap: 8px; min-width: 240px;
  }
  .edit-panel-title { font-weight: bold; color: #0a246a; font-size: 0.9em; margin-bottom: 2px; }
  /* Who asked for this item now lives quietly at the top of the edit dialog
     instead of on a status bar under the card. */
  .edit-requester { font-size: 0.8em; color: #6a6a5c; font-style: italic; margin-bottom: 4px; }
  .edit-field { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 10px; }
  .edit-field > label { font-size: 0.85em; color: #333; text-align: right; }
  .edit-field input[type=text], .edit-field input[type=number] { width: 100%; }
  .edit-emoji-input { width: 52px !important; text-align: center; font-size: 1.2em !important; }
  .edit-need { display: flex; gap: 8px; }
  .edit-need input[type=number] { width: 72px !important; flex: 0 0 auto; }
  .edit-need input[type=text] { flex: 1; }
  .edit-panel-buttons {
    display: flex; justify-content: flex-end; gap: 8px;
    margin-top: 6px; padding-top: 10px; border-top: 1px solid #d6d3c3;
  }

  /* The comments live inside a real-looking floating XP program window — a proper
     Luna blue caption bar with min/max/close buttons pinned to the right, a
     contact bar with avatar + "online" status, the white "X says:" conversation
     log, an emoticon toolbar, and a compose bar. The chat IS the comments —
     there's no separate "comments" button. It floats (drop shadow) but doesn't drag. */
  .msn-chat {
    border: 1px solid #0a3d91; border-radius: 6px 6px 4px 4px; overflow: hidden;
    background: #ece9d8;
    box-shadow: 0 8px 22px rgba(0,0,0,0.38), 0 1px 0 rgba(255,255,255,0.6) inset;
  }
  /* Collapsed, the chat is a compact glossy blue Luna button ("💬 Chat (N…)")
     that doesn't span the row — no window frame, no fake min/max/close. */
  /* Collapsed, the chat is a rectangular glossy XP taskbar button — icon + title,
     the same blue Luna caption gradient, a bright top highlight and a 3px radius
     (not a modern pill). Hover glows amber; pressed it sinks in. */
  .msn-chat:not([open]) {
    align-self: flex-start; max-width: 100%;
    border: 1px solid #17458f; border-radius: 3px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -2px 3px rgba(0,0,60,0.35), 0 1px 2px rgba(0,0,0,0.3);
  }
  .msn-chat:not([open]) > summary.msn-titlebar { height: auto; padding: 6px 14px; }
  .msn-chat:not([open]) .msn-winbtns { display: none; }
  .msn-chat:not([open]):hover {
    border-color: #e08a1e;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 0 5px 1px rgba(255,177,40,0.8);
  }
  .msn-chat:not([open]):active {
    box-shadow: inset 1px 2px 4px rgba(0,0,60,0.5);
  }
  .msn-chat:not([open]):active > summary.msn-titlebar { padding-top: 7px; padding-bottom: 5px; }

  .msn-chat[open] { align-self: stretch; }
  .msn-titlebar {
    display: flex; align-items: center; gap: 6px;
    padding: 0 4px 0 8px; height: 26px;
    color: #fff; font-size: 0.78em; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,20,0.5);
    /* the same Luna caption gradient the app window uses */
    background: linear-gradient(180deg,#0997ff 0%,#0053ee 8%,#0050ee 40%,#0165ff 88%,#0165ff 93%,#0997ff 95%,#0165ff 100%);
  }
  /* The whole caption bar is the toggle — the chat sits "minimized" (just its
     title bar) until you click it open, like restoring an MSN window. */
  .msn-chat > summary.msn-titlebar { cursor: pointer; list-style: none; }
  .msn-chat > summary.msn-titlebar::-webkit-details-marker { display: none; }
  .msn-chat > summary.msn-titlebar::marker { content: ''; }
  .msn-title-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Caption buttons hug the right edge and look like real XP window controls. */
  .msn-winbtns { display: flex; gap: 2px; margin-left: auto; flex-shrink: 0; }
  .msn-winbtn {
    width: 20px; height: 18px; display: flex; align-items: center; justify-content: center;
    font-size: 9px; line-height: 1; color: #fff; font-weight: bold;
    border: 1px solid rgba(255,255,255,0.85); border-radius: 3px;
    text-shadow: 0 1px 1px rgba(0,0,0,0.4);
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.5), inset 0 -2px 3px rgba(0,0,60,0.3);
  }
  .msn-winbtn.min, .msn-winbtn.max { background: linear-gradient(180deg,#4aa3ff 0%,#1c6fe0 45%,#0d59d6 100%); }
  .msn-winbtn.close { background: linear-gradient(180deg,#f9b38c 0%,#e0632f 8%,#e14f28 45%,#d0330f 100%); }
  /* Menu bar — the row of pretend menus that every MSN window had. */
  .msn-menubar {
    display: flex; gap: 12px; padding: 2px 9px;
    background: linear-gradient(180deg,#fdfdfb,#ece9d8);
    border-bottom: 1px solid #d5d2c4;
    font-size: 0.7em; color: #333;
  }
  .msn-menu-item { cursor: default; }
  .msn-menu-item:first-letter { text-decoration: underline; }
  /* "To:" line on the left, framed display picture (the item emoji) on the right. */
  .msn-contactbar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    background: #fff; border-bottom: 1px solid #cdd9ea; padding: 6px 9px;
  }
  .msn-to { font-size: 0.75em; color: #555; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msn-to b { color: #245fcc; }
  .msn-dp {
    width: 34px; height: 34px; flex-shrink: 0;
    border: 2px solid #b7c8e0; border-radius: 2px;
    background: linear-gradient(135deg,#e4efff,#a9c9f0);
    display: flex; align-items: center; justify-content: center; font-size: 1.25em;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }
  .msn-log { background: #fff; padding: 8px 10px; max-height: 240px; overflow-y: auto; }
  .msn-msg { margin-bottom: 8px; font-size: 0.87em; line-height: 1.4; }
  .msn-msg:last-child { margin-bottom: 0; }
  .msn-name { font-weight: bold; font-size: 0.9em; }
  .msn-time { color: #b3b3b3; font-size: 0.82em; font-weight: normal; margin-left: 5px; }
  .msn-body { display: block; margin-left: 16px; color: #000; word-break: break-word; }
  .msn-empty { color: #999; font-size: 0.85em; font-style: italic; text-align: center; padding: 12px 0; }
  /* Single row of emoticons that scrolls sideways when it can't fit (mobile),
     rather than wrapping to multiple rows or pushing the window wider. */
  .msn-toolbar {
    display: flex; align-items: center; flex-wrap: nowrap; gap: 2px;
    background: linear-gradient(180deg,#fbfdff,#e7eefa);
    border-top: 1px solid #cdd9ea; padding: 3px 6px;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
  }
  .msn-tool {
    flex: 0 0 auto;
    border: 1px solid transparent; background: none; box-shadow: none;
    padding: 1px 2px; font-size: 0.95em; line-height: 0; cursor: pointer; border-radius: 3px;
  }
  .msn-tool:hover { border-color: #7fa8e0; background: #fff; box-shadow: none; }
  .msn-tool:active { box-shadow: inset 1px 1px 2px rgba(0,0,0,0.2); }
  .msn-tool > .msn-emoticon { display: block; }
  /* The MSN emoticon PNGs are tiny 8-bit art — render them crisp, not blurred. */
  .msn-emoticon {
    width: 19px; height: 19px; vertical-align: -4px;
    image-rendering: pixelated; image-rendering: crisp-edges;
  }
  .msn-compose {
    display: flex; gap: 6px; padding: 8px; align-items: stretch; width: 100%;
    border-top: 1px solid #cdd9ea; background: #ece9d8;
  }
  /* Full-width sunken message box + a bold Luna Send button, like MSN's composer. */
  .msn-compose input[type=text] {
    flex: 1 1 auto; width: 100%; min-width: 0;
    padding: 9px 10px; border: 1px solid #7f9db9; background: #fff;
    box-shadow: inset 1px 1px 2px rgba(0,0,0,0.15);
  }
  .msn-compose .btn { flex: 0 0 auto; min-width: 78px; font-weight: bold; }

  /* Stuff-tab controls row: sort toggle on the left, expand-all on the right. */
  .stuff-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .stuff-controls .sort-toggle { margin: 0; }
  .expand-all-btn { font-size: 0.8em; padding: 3px 12px; }

  /* Items grouped into "still need these" / "all covered" sections, styled like
     XP Explorer's "show in groups" headers: a blue bold label with a hairline
     rule running out to the right and a little count chip. */
  .stuff-section { margin-top: 16px; }
  .stuff-section:first-child { margin-top: 8px; }
  .stuff-section-header {
    display: flex; align-items: center; gap: 8px;
    color: #2360cc; font-weight: bold; font-size: 0.95em; margin: 0 2px 4px;
  }
  .stuff-section-header.done { color: #2f8f3a; }
  .stuff-section-header::after {
    content: ''; flex: 1; height: 0; border-top: 1px solid currentColor; opacity: 0.4;
  }
  .section-count {
    font-size: 0.78em; font-weight: bold;
    border-radius: 2px; padding: 0 6px; line-height: 1.4;
    background: linear-gradient(180deg,#ffffff,#e8eefb);
    box-shadow: inset 0 0 0 1px #fff;
  }
  .stuff-section-header .section-count { color: #2360cc; border: 1px solid #7aa0d8; }
  .stuff-section-header.done .section-count { color: #2f8f3a; border: 1px solid #86bf8c; }
  .stuff-empty { color: #555; font-style: italic; text-align: center; padding: 20px 0; }

  /* Sort control reads as an XP toolbar: a label + small toggle buttons where the
     active one is depressed (sunken with a light-blue tint), like a pressed
     toolbar button — not a big blue slab. */
  .sort-toggle { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 10px 0; font-size: 0.85em; }
  .sort-toggle .sort-label { color: #333; }
  .sort-toggle a {
    text-decoration: none; color: #000; padding: 3px 12px; border-radius: 3px;
    border: 1px solid #003c74;
    background: linear-gradient(180deg,#fdfeff 0%,#f2f2ec 45%,#ebebdf 52%,#f6f5ee 90%,#ffffff 100%);
    box-shadow: inset 0 0 0 1px #fff;
  }
  .sort-toggle a:hover { border-color: #e08a1e; box-shadow: inset 0 0 0 1px #fff, 0 0 3px 1px rgba(255,177,40,0.7); }
  .sort-toggle a.active {
    background: linear-gradient(180deg,#c9dbf2,#aecbec); font-weight: bold;
    box-shadow: inset 1px 1px 2px rgba(0,0,0,0.30);
  }

  /* "add an item…" opens an XP dialog (see .modal-box) rather than expanding inline. */
  .add-stuff-bar { margin: 10px 0; }
  .add-stuff-btn { width: 100%; font-size: 1.05em; font-weight: bold; padding: 10px; }

  /* ===== authentic Windows XP "Luna" window chrome =====
     The whole app sits inside one XP window: rounded blue frame, glossy
     title bar, and the min/maximize/close caption buttons in the corner. */
  .xp-window {
    max-width: 900px; width: calc(100% - 44px); margin: 22px auto 30px;
    background: #0831d9;               /* the 3px blue window frame */
    padding: 0 3px 3px;
    border-radius: 8px 8px 0 0;
    box-shadow: 0 10px 30px rgba(0,0,0,0.55);
  }
  .xp-titlebar {
    height: 28px; display: flex; align-items: center; gap: 6px;
    margin: 0 -3px; padding: 0 3px 0 6px;
    border-radius: 8px 8px 0 0;
    color: #fff; font-weight: bold; font-family: Tahoma, sans-serif; font-size: 0.9em;
    text-shadow: 1px 1px 2px rgba(0,0,20,0.55);
    /* the unmistakable Luna caption gradient */
    background: linear-gradient(180deg,
      #0997ff 0%, #0053ee 8%, #0050ee 40%, #0165ff 88%,
      #0165ff 93%, #0997ff 95%, #0165ff 100%);
  }
  .xp-titlebar-icon { font-size: 1.05em; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.4)); }
  .xp-titlebar-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.2px; }
  .xp-titlebar-buttons { display: flex; gap: 2px; margin-left: 8px; }
  .xp-tb-btn {
    width: 21px; height: 21px; display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,0.9); border-radius: 3px;
    color: #fff; font-size: 11px; font-weight: bold; line-height: 1;
    text-shadow: 0 1px 1px rgba(0,0,0,0.4);
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.55), inset 0 -3px 4px rgba(0,0,60,0.35);
  }
  .xp-tb-btn.min, .xp-tb-btn.max { background: linear-gradient(180deg,#4aa3ff 0%,#1c6fe0 45%,#0d59d6 100%); }
  .xp-tb-btn.close { background: linear-gradient(180deg,#f9b38c 0%,#e0632f 8%,#e14f28 45%,#d0330f 100%); }
  .xp-window-body { background: #ece9d8; padding: 4px 6px 8px; }
  .xp-window-body main { max-width: none; margin: 0; padding: 6px 4px; }
  @media (max-width: 600px) { .xp-titlebar-text { font-size: 0.95em; } }

  /* Little draggable XP windows used for the "me" tab sections — each section is
     its own Luna window (title bar + caption buttons) instead of a flat card, and
     they're staggered slightly so they read like real stacked windows on a desktop.
     Grab a title bar to drag it around. */
  .xp-mini {
    position: relative; margin: 16px 0; max-width: 580px;
    background: #0831d9; padding: 0 3px 3px; border-radius: 8px 8px 0 0;
    box-shadow: 0 8px 22px rgba(0,0,0,0.42);
  }
  .xp-mini-titlebar {
    height: 26px; display: flex; align-items: center; gap: 6px;
    margin: 0 -3px; padding: 0 3px 0 9px; border-radius: 8px 8px 0 0;
    color: #fff; font-weight: bold; font-family: Tahoma, sans-serif; font-size: 0.85em;
    text-shadow: 1px 1px 2px rgba(0,0,20,0.55);
    background: linear-gradient(180deg,#0997ff 0%,#0053ee 8%,#0050ee 40%,#0165ff 88%,#0165ff 93%,#0997ff 95%,#0165ff 100%);
    cursor: move; user-select: none; touch-action: none;
  }
  .xp-mini-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .xp-mini-btns { display: flex; gap: 2px; margin-left: 8px; }
  .xp-mini-body { background: #ece9d8; padding: 12px 14px; }
  .xp-mini-body > h3:first-child { margin-top: 0; }
  .xp-mini.dragging { opacity: 0.94; box-shadow: 0 16px 38px rgba(0,0,0,0.55); z-index: 60; }
  @media (max-width: 600px) { .xp-mini { margin-left: 0 !important; max-width: 100%; } }

  /* me-tab: festival checklist rows (inside its window) */
  .checklist-rows { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 8px; }
  .checklist-row { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-radius: 3px; }
  .checklist-row:hover { background: rgba(49,106,197,0.07); }
  .checklist-check { margin: 0; display: inline-flex; }
  .check-toggle {
    background: none; border: none; box-shadow: none; padding: 2px 3px;
    line-height: 1; cursor: pointer; color: inherit; display: inline-flex; align-items: center;
  }
  .check-toggle:hover { background: none; box-shadow: none; }
  .check-toggle:hover .xp-checkbox { border-color: #5a8fd6; }
  /* A real Windows XP checkbox: sunken white square with a green tick when checked. */
  .xp-checkbox {
    display: inline-block; width: 14px; height: 14px; box-sizing: border-box;
    background: #fff; border: 1px solid #7f9db9; border-radius: 2px; position: relative;
    box-shadow: inset 1px 1px 1px rgba(0,0,0,0.18);
  }
  .xp-checkbox.checked::after {
    content: ''; position: absolute; left: 4px; top: 0;
    width: 4px; height: 8px; border: solid #1a7a1a; border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .checklist-label { flex: 1; min-width: 0; }
  .checklist-req {
    font-size: 0.68em; color: #6a6a5c; text-transform: uppercase; letter-spacing: 0.4px;
    border: 1px solid #c9c6b5; background: #f1efe4; border-radius: 2px; padding: 1px 6px;
  }
  .checklist-del { margin: 0; }
  .checklist-del-btn { padding: 0 8px; font-size: 0.8em; line-height: 1.5; }
  .checklist-add { display: flex; gap: 6px; margin-top: 8px; padding-top: 9px; border-top: 1px solid #d6d3c3; }
  .checklist-add input[type=text] { flex: 1; min-width: 0; }

  /* me-tab: "what im bringing" list — a tidy file-listing look */
  .mine-empty { color: #555; font-style: italic; margin: 4px 0; }
  .bringing-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .bringing-row {
    display: flex; align-items: center; gap: 10px; padding: 5px 8px;
    background: #fff; border: 1px solid #cfd8e6; border-radius: 3px;
  }
  .bringing-row.packed { background: #f2f8f2; border-color: #b7d7b7; }
  .bringing-icon {
    width: 32px; height: 32px; flex: 0 0 auto; font-size: 1.35em;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid #c3d2ec; border-radius: 3px; background: linear-gradient(135deg,#eef5ff,#d3e3f7);
  }
  .bringing-name { flex: 1; min-width: 0; font-weight: bold; }
  .bringing-qty {
    font-size: 0.85em; color: #0a246a; white-space: nowrap;
    background: linear-gradient(180deg,#fff,#e8eefb); border: 1px solid #9fbbe4;
    border-radius: 2px; padding: 1px 7px;
  }
  .bringing-packed { font-size: 0.72em; color: #1a7a1a; text-transform: uppercase; letter-spacing: 0.3px; }

  /* me-tab: "my ride" info panel */
  .ride-panel, .ride-panel:visited {
    display: flex; align-items: center; gap: 12px; padding: 9px 11px; margin-top: 2px;
    background: linear-gradient(180deg,#fbfdff,#eef3fc); border: 1px solid #b9c9e6;
    border-radius: 4px; box-shadow: inset 0 1px 0 #fff;
    text-decoration: none; color: inherit; cursor: pointer;
  }
  .ride-panel:hover { border-color: #5a8fd6; box-shadow: inset 0 1px 0 #fff, 0 0 4px 1px rgba(90,143,214,0.45); }
  .ride-icon { font-size: 1.8em; flex: 0 0 auto; }
  .ride-info { flex: 1; min-width: 0; line-height: 1.35; }
  .ride-go { flex: 0 0 auto; font-size: 0.82em; font-weight: bold; color: #0a3d91; white-space: nowrap; }
  .ride-empty { background: linear-gradient(180deg,#fffef6,#fdf6e0); border-color: #d9c98f; }

  /* XP "group box" — the etched fieldset used across Control Panel dialogs. */
  fieldset { border: 1px solid #d6d3c3; border-top-color: #b7b4a5; border-radius: 3px; margin: 10px 0; padding: 10px 12px; background: rgba(255,255,255,0.35); }
  legend { color: #0a246a; font-weight: bold; padding: 0 4px; }

  /* Luna text selection + scrollbars — the little touches that sell it. */
  ::selection { background: #316ac5; color: #fff; }
  * { scrollbar-color: #a6c0e8 #d7e4f5; scrollbar-width: thin; }
  ::-webkit-scrollbar { width: 17px; height: 17px; }
  ::-webkit-scrollbar-track { background: #eef3fb; box-shadow: inset 1px 0 1px rgba(0,0,0,0.08); }
  ::-webkit-scrollbar-thumb {
    background: linear-gradient(90deg,#f2f6fd 0%,#c6d9f2 45%,#9db9e0 55%,#c6d9f2 100%);
    border: 1px solid #6f97cf; border-radius: 2px;
    box-shadow: inset 1px 1px 0 rgba(255,255,255,0.8);
  }
  ::-webkit-scrollbar-thumb:hover { background: linear-gradient(90deg,#fbfcff,#d7e6fa 45%,#b0c9ea 55%,#d7e6fa); }
  ::-webkit-scrollbar-corner { background: #eef3fb; }
`;

const CONFETTI_SCRIPT = `
function campConfetti(el) {
  el.classList.add('pop');
  setTimeout(function () { el.classList.remove('pop'); }, 350);
  var rect = el.getBoundingClientRect();
  var bits = ['🎉','✨','🌟','💫','🎊'];
  for (var i = 0; i < 10; i++) {
    var span = document.createElement('span');
    span.className = 'confetti-piece';
    span.textContent = bits[Math.floor(Math.random() * bits.length)];
    span.style.left = (rect.left + rect.width / 2) + 'px';
    span.style.top = (rect.top + rect.height / 2) + 'px';
    span.style.fontSize = (12 + Math.random() * 10) + 'px';
    var angle = Math.random() * Math.PI * 2;
    var dist = 35 + Math.random() * 55;
    span.style.setProperty('--confetti-end', 'translate(' + (Math.cos(angle) * dist) + 'px,' + (Math.sin(angle) * dist - 25) + 'px)');
    span.style.setProperty('--confetti-spin', (Math.random() * 360) + 'deg');
    document.body.appendChild(span);
    setTimeout((function (s) { return function () { s.remove(); }; })(span), 750);
  }
}

// Render every emoji in the page with the UnifontEX pixel font by wrapping each
// emoji run in a <span class="pixmoji">. Runs on load and after each HTMX swap.
// Skips inputs/scripts and already-wrapped spans so it's safe to re-run.
var PIXMOJI_RE = /(?:\\p{Extended_Pictographic}(?:️|‍|\\p{Emoji_Modifier}|\\p{Extended_Pictographic})*|[\\u{1F1E6}-\\u{1F1FF}]{2})/gu;
// True if UnifontEX has a real glyph for this codepoint (binary search over the
// injected coverage ranges). Emoji it lacks stay native so we don't show tofu.
function pixCovered(cp) {
  var r = window.PIXMOJI_RANGES;
  if (!r || !r.length) return true;
  var lo = 0, hi = (r.length >> 1) - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1, s = r[mid * 2], e = r[mid * 2 + 1];
    if (cp < s) hi = mid - 1;
    else if (cp > e) lo = mid + 1;
    else return true;
  }
  return false;
}
function pixmojify(root) {
  if (!root || root.nodeType === undefined || !document.createTreeWalker) return;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      PIXMOJI_RE.lastIndex = 0;
      if (!PIXMOJI_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      var p = n.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      var t = p.nodeName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA' || t === 'INPUT') return NodeFilter.FILTER_REJECT;
      if (p.classList && p.classList.contains('pixmoji')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  var nodes = [], n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(function (node) {
    var text = node.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
    PIXMOJI_RE.lastIndex = 0;
    while ((m = PIXMOJI_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (pixCovered(m[0].codePointAt(0))) {
        var span = document.createElement('span');
        span.className = 'pixmoji';
        // Strip any variation selectors (0xFE0E/0xFE0F). We must NOT append a
        // text-presentation selector char: Unifont has a visible glyph for it, so
        // iOS Safari renders a box after every emoji. Dropping the color-forcing
        // 0xFE0F is enough — the explicit .pixmoji font-family (+ font-variant-emoji)
        // makes the pixel glyph win.
        var glyph = '';
        for (var ci = 0; ci < m[0].length; ci++) {
          var cc = m[0].charCodeAt(ci);
          if (cc !== 0xFE0F && cc !== 0xFE0E) glyph += m[0][ci];
        }
        span.textContent = glyph;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}
// Keep password managers (1Password/LastPass/Bitwarden) from popping their autofill
// icon over our plain text fields — a field named "name"/"email" reads to them like a
// login. We tag every input so their inline menu stays out of the way. Safe to re-run.
function suppressPwManagers(root) {
  if (!root || !root.querySelectorAll) return;
  var inputs = root.querySelectorAll('input:not([data-1p-ignore]), textarea:not([data-1p-ignore])');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    el.setAttribute('data-1p-ignore', 'true');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-bwignore', 'true');
    el.setAttribute('data-form-type', 'other');
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
  }
}
// After signing in via the "i'll bring this" prompt we come back with ?pledge=<id>
// — open that item's pledge dialog automatically so the flow just continues.
function campAutoOpenPledge() {
  try {
    var id = new URLSearchParams(window.location.search).get('pledge');
    if (!id) return;
    var modal = document.getElementById('pledge-modal-' + id);
    if (modal) { modal.style.display = 'flex'; var inp = modal.querySelector('input[name=qty]'); if (inp) inp.focus(); }
  } catch (e) {}
}
document.addEventListener('DOMContentLoaded', function () { pixmojify(document.body); suppressPwManagers(document.body); campAutoOpenPledge(); });
document.addEventListener('htmx:afterSwap', function (e) { pixmojify(e.target); suppressPwManagers(e.target); });

// Make the little "me"-tab XP windows draggable by their title bar. Position is
// tracked as an accumulated translate on each window (dataset.dx/dy) so repeated
// drags stack. Pressing a caption button doesn't start a drag. Document-level so it
// keeps working for windows re-rendered by HTMX swaps.
(function () {
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest) return;
    var handle = e.target.closest('.xp-mini-titlebar');
    if (!handle || e.target.closest('.xp-tb-btn')) return;
    var win = handle.closest('.xp-mini');
    if (!win) return;
    var dx = parseFloat(win.dataset.dx || '0'), dy = parseFloat(win.dataset.dy || '0');
    drag = { win: win, sx: e.clientX, sy: e.clientY, bx: dx, by: dy };
    win.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var nx = drag.bx + (e.clientX - drag.sx), ny = drag.by + (e.clientY - drag.sy);
    drag.win.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
    drag.win.dataset.dx = nx; drag.win.dataset.dy = ny;
  });
  function endDrag() { if (drag) { drag.win.classList.remove('dragging'); drag = null; } }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
})();

// MSN emoticon toolbar: append the typed emoticon into the chat's compose box.
function msnEmote(el, txt) {
  var chat = el.closest('.msn-chat');
  var input = chat && chat.querySelector('input[name=body]');
  if (input) { input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + txt; input.focus(); }
}

// Expand-all / collapse-all toggle above the stuff list. Expands every card if
// any is collapsed; otherwise collapses them all. Chats are deliberately left
// closed in bulk — expanding every conversation at once is too much noise.
function campToggleExpandAll(btn) {
  var list = document.getElementById('stuff-list');
  var dets = list ? list.querySelectorAll('.item-details') : [];
  var anyClosed = false;
  for (var i = 0; i < dets.length; i++) { if (!dets[i].open) { anyClosed = true; break; } }
  for (var j = 0; j < dets.length; j++) {
    // Close the chat cleanly FIRST (removeAttribute avoids a ghost-painted nested
    // <details> that shows expanded-but-empty), then set the card's state. Bulk
    // expand/collapse always leaves chats closed.
    var chat = dets[j].querySelector('.msn-chat');
    if (chat) chat.removeAttribute('open');
    dets[j].open = anyClosed;
  }
  btn.textContent = anyClosed ? '⊟ collapse all' : '⊞ expand all';
}

// Opening a single item card (by clicking its header) pops its chat open too, so
// one expanded tile shows the whole conversation. Bulk expand-all skips this.
document.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var summary = e.target.closest('.item-summary');
  if (!summary) return;
  var card = summary.parentElement; // .item-details
  setTimeout(function () {
    var chat = card.querySelector('.msn-chat');
    if (chat) chat.open = card.open;
  }, 0);
});

// Live "hey, that name's taken" heads-up as you type — never blocks submission,
// just a nudge in case you didn't mean to pick an existing name.
var campNameCheckTimer;
document.addEventListener('input', function (e) {
  if (!e.target.classList || !e.target.classList.contains('signin-name-input')) return;
  var input = e.target;
  var notice = (input.closest('form') || input.parentElement).querySelector('.name-taken-notice');
  if (!notice) return;
  clearTimeout(campNameCheckTimer);
  var val = input.value.trim();
  if (!val) { notice.textContent = ''; return; }
  campNameCheckTimer = setTimeout(function () {
    fetch('/signin/check-name?name=' + encodeURIComponent(val))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (input.value.trim() !== val) return;
        notice.textContent = data.taken
          ? ('heads up — someone already goes by "' + data.display_name + '". if that\\'s you, cool — you\\'ll be signed in as them. otherwise pick something more identifiable.')
          : '';
      })
      .catch(function () {});
  }, 350);
});
`;

export function tickerHtml(entries) {
    if (!entries || !entries.length) {
        return html`<div class="marquee-wrap"><span class="marquee-badge">📢 News</span><div class="marquee-track"><span class="marquee" style="animation-duration:20s">nothing's happened yet... be the first!</span></div></div>`;
    }
    const text = entries.map((e) => e.summary).join('   ·   ');
    // Duration scales with content length so the scroll speed (px/sec) stays roughly
    // constant instead of whipping faster as more news accumulates.
    const duration = Math.max(25, Math.round(text.length / 6));
    return html`<div class="marquee-wrap"><span class="marquee-badge">📢 News</span><div class="marquee-track"><span class="marquee" style="animation-duration:${duration}s">${text}&nbsp;&nbsp;·&nbsp;&nbsp;${text}</span></div></div>`;
}

// Rover the XP Search Companion: a contextual assistant tip. Not signed in → nudge
// to sign in; signed in on a fest → remind about the festival + parking passes. Copy
// is written in cheery early-2000s Windows-helper voice. Returns '' when there's
// nothing useful to say (signed in, but not on a festival page).
function dogAssistant(c, festival, person) {
    let bubble;
    if (!person) {
        bubble = html`
          <span class="dog-title">Hi there — I'm Rover!</span>
          It looks like you're just visiting. Would you like to <a href="/signin">sign in</a>?
          It only takes a moment, and then you can claim what you're bringing and save your seat in a carpool.`;
    } else if (festival) {
        bubble = html`
          <span class="dog-title">Hey ${person.display_name}!</span>
          Did you remember to buy your <b>festival pass</b> and <b>parking pass</b>? If you've got them,
          pop over to the <a href="/f/${festival.id}/mine">me</a> tab and check them off your list.`;
    } else {
        return '';
    }
    return html`
    <div class="dog-assistant">
      <div class="dog-bubble">${bubble}</div>
      <img class="dog-img" src="/dog.webp" alt="Rover the assistant dog">
    </div>`;
}

function festPicker(c, festival, festivals) {
    const person = c.get('person');
    return html`
    <div class="fest-picker">
      <div>
        ${festival
            ? html`<select onchange="if(this.value) window.location='/f/'+this.value">
                 <option value="">switch fest...</option>
                 ${(festivals || []).map((f) => html`<option value="${f.id}" ${f.id === festival.id ? 'selected' : ''}>${f.name}</option>`)}
               </select>`
            : html`<b>choose a fest below</b>`}
        <a class="btn" href="/fests/new">+ add a fest</a>
      </div>
      <div>
        ${person
            ? html`signed in as <b>${person.display_name}</b> · <a href="/signout">sign out</a>`
            : html`<a href="/signin">sign in</a> <i>(takes 2 seconds)</i>`}
      </div>
    </div>`;
}

export async function renderPage(c, { title, activeTab = '', body, festival = null }) {
    const db = c.env.DB;
    const person = c.get('person');

    let festivals = [];
    try {
        festivals = (await db.prepare('SELECT id, name FROM festivals WHERE deleted_at IS NULL ORDER BY name').all()).results;
    } catch (e) { /* ok */ }

    let ticker = [];
    if (festival) {
        try {
            ticker = (await db.prepare(`
                SELECT summary FROM audit_log
                WHERE festival_id = ? AND action != 'undo'
                ORDER BY created_at DESC LIMIT 15
            `).bind(festival.id).all()).results;
        } catch (e) { /* ok */ }
    }

    const tabs = festival
        ? [
            ['stuff', `/f/${festival.id}/stuff`, 'stuff'],
            ['ppl', `/f/${festival.id}/ppl`, 'ppl'],
            ['cars', `/f/${festival.id}/rides`, 'rides'],
            ['me', `/f/${festival.id}/mine`, 'mine'],
            ['log', `/f/${festival.id}/log`, 'log'],
        ]
        : [];

    return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} :: camp planner</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script>window.PIXMOJI_RANGES=${raw(JSON.stringify(PIXMOJI_COVERED_RANGES))};</script>
  <script>${raw(CONFETTI_SCRIPT)}</script>
  <style>${raw(RETRO_CSS)}</style>
</head>
<body>
  ${tickerHtml(ticker)}
  <header class="site">
    ${festPicker(c, festival, festivals)}
  </header>
  <h1 class="title">
    <span class="title-icon">🏕️</span>
    <span class="title-text">${festival ? festival.name : 'camp planner'}</span>
  </h1>
  ${dogAssistant(c, festival, person)}
  <div id="signin-modal-overlay"></div>
  <div id="toast"></div>
  <div class="xp-window">
    <div class="xp-titlebar">
      <span class="xp-titlebar-text">${festival ? festival.name : 'camp planner'} — Camp Planner</span>
      <span class="xp-titlebar-buttons">
        <span class="xp-tb-btn min" aria-hidden="true">_</span>
        <span class="xp-tb-btn max" aria-hidden="true">❐</span>
        <span class="xp-tb-btn close" aria-hidden="true">✕</span>
      </span>
    </div>
    <div class="xp-window-body">
      ${festival ? html`<nav class="tabs">${tabs.map(([label, href, key]) => html`<a href="${href}" class="${key === activeTab ? 'active' : ''}">${label}</a>`)}</nav>` : ''}
      <main id="main">
        ${body}
      </main>
    </div>
  </div>
  <footer class="site">
    <div class="badge-row">
      ${['under construction', 'best viewed IE/Netscape', 'valid html', 'NEW!', 'mailbox', 'rave on'].map((label) => html`<div class="badge">${label}</div>`)}
    </div>
    <div class="webring">← <a href="/webring/${festival ? festival.id : ''}/prev">prev</a> | <a href="/webring/${festival ? festival.id : ''}/random">random</a> | <a href="/webring/${festival ? festival.id : ''}/next">next</a> →</div>
    <div style="margin-top:8px;font-size:0.8em;"><a href="/admin">admin</a> · we totally log your ip, fyi, lol</div>
  </footer>
</body>
</html>`;
}
