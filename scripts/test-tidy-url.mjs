// Runs the REAL campTidyUrl() out of camp.js against a stubbed browser and checks
// what it leaves in the address bar. Worth a test because it only ever fires on the
// hop back from a sign-in redirect: if it broke, the sign-in resume params would sit
// in the URL (or worse, a legitimate ?sort= would get eaten) and nothing would fail
// loudly. Usage: node scripts/test-tidy-url.mjs
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const src = readFileSync(new URL('../public/camp.js', import.meta.url), 'utf8');

function tidy(href) {
    let replaced = null;
    const noop = () => {};
    const sandbox = {
        URL,
        document: { addEventListener: noop, createTreeWalker: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: {} },
        window: {
            location: { href, search: href.slice(href.indexOf('?')) },
            history: { state: null, replaceState: (_s, _t, url) => { replaced = url; } },
            matchMedia: () => ({ matches: false }),
            addEventListener: noop,
        },
        setTimeout: noop,
        setInterval: noop,
        requestAnimationFrame: noop,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        localStorage: { getItem: () => null, setItem: noop },
        NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    };
    sandbox.history = sandbox.window.history;
    sandbox.location = sandbox.window.location;
    sandbox.globalThis = sandbox;
    const ctx = createContext(sandbox);
    runInContext(src, ctx);
    runInContext('campTidyUrl()', ctx);
    return replaced; // null = left the URL alone
}

const cases = [
    ['https://x.dev/f/1/stuff?expand=item-5&pledge=5#item-5', '/f/1/stuff#item-5'],
    ['https://x.dev/f/1/stuff?pledge=5', '/f/1/stuff'],
    ['https://x.dev/f/1/stuff?sort=name&expand=item-5#item-5', '/f/1/stuff?sort=name#item-5'],
    ['https://x.dev/f/1/rides?expand=car-3#car-3', '/f/1/rides#car-3'],
    ['https://x.dev/f/1/stuff?sort=name', null],   // the user's own param — don't touch
    ['https://x.dev/f/1/stuff', null],             // nothing to do
];

let failed = 0;
for (const [href, want] of cases) {
    const got = tidy(href);
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${href}\n    → ${got === null ? '(untouched)' : got}${ok ? '' : `   WANT ${want === null ? '(untouched)' : want}`}`);
}
console.log(failed ? `FAIL — ${failed}/${cases.length}` : `OK — ${cases.length}/${cases.length}`);
process.exit(failed ? 1 : 0);
