// Flags client-side functions and CSS classes nothing references any more — the
// stuff that quietly accumulates when features get reworked. Scans camp.js for
// function declarations and retro.css for class selectors, then looks for uses
// across camp.js, the server-rendered markup in src/, and public/.
// Usage: node scripts/find-dead-frontend.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(js|mjs|css|html)$/.test(name)) out.push(p);
    }
    return out;
}

const files = [...walk('src'), ...walk('public')].filter((f) => !f.endsWith('htmx-1.9.12.min.js'));
const corpus = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const js = corpus.get('public/camp.js') || '';
const css = corpus.get('public/retro.css') || '';

const uses = (name, skipDecl) => {
    let n = 0;
    for (const [f, text] of corpus) {
        const re = new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'g');
        let m = (text.match(re) || []).length;
        if (f === 'public/camp.js' && skipDecl) m -= 1; // don't count its own declaration
        n += m;
    }
    return n;
};

const deadFns = [...js.matchAll(/^function ([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]).filter((fn) => uses(fn, true) === 0);

// Class selectors defined in CSS but never emitted anywhere.
// Strip comments and url()s FIRST. Without this, any dotted string in the file
// reads as a class: a `url('…cdn.jsdelivr.net/…/Font.woff2')` reported `.jsdelivr`
// and `.woff2` as dead classes, which is noise you learn to skim past — and
// skimming past it is how a 2 MB third-party font sat on the critical path
// unnoticed. A checker that cries wolf is worse than no checker.
const cssSelectors = css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/url\([^)]*\)/g, ' ');
const classes = new Set([...cssSelectors.matchAll(/\.([a-z][\w-]{3,})/g)].map((m) => m[1]));
const deadClasses = [...classes].filter((c) => {
    let seen = 0;
    for (const [f, text] of corpus) if (f !== 'public/retro.css') seen += (text.includes(c) ? 1 : 0);
    return seen === 0;
});

console.log(deadFns.length ? `unreferenced functions in camp.js:\n  ${deadFns.join('\n  ')}` : 'no unreferenced functions in camp.js');
console.log(deadClasses.length ? `\nCSS classes never emitted:\n  ${deadClasses.map((c) => '.' + c).join('\n  ')}` : '\nno orphaned CSS classes');
