// Where does a page's HTML weight actually go? Prints the biggest repeated blocks
// plus transfer size, so "the stuff page is huge" turns into a ranked list.
// Usage: node scripts/page-weight.mjs [path] [cookieHeader]
import { gzipSync, brotliCompressSync } from 'node:zlib';

const path = process.argv[2] || '/f/1/stuff';
const cookie = process.argv[3] || '';
const res = await fetch(`http://localhost:8787${path}`, cookie ? { headers: { cookie } } : undefined);
const h = await res.text();

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const count = (re) => (h.match(re) || []).length;
const bytes = (re) => (h.match(re) || []).reduce((s, m) => s + m.length, 0);

const parts = [
    ['msn chat blocks', /<details class="msn-chat"[\s\S]*?<\/details>/g],
    ['  ├ emoticon toolbars', /<div class="msn-toolbar">[\s\S]*?<\/div>/g],
    ['  ├ menu bars', /<div class="msn-menubar">[\s\S]*?<\/div>\s*<\/div>/g],
    ['  └ compose forms', /<form class="msn-compose"[\s\S]*?<\/form>/g],
    ['edit panels', /<form id="edit-form-item-\d+"[\s\S]*?<\/form>/g],
    ['pledge modals', /<div class="modal-backdrop" id="pledge-modal-\d+"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g],
    ['item cards (total)', /<div class="card item-card[\s\S]*?(?=<div class="card item-card|<div class="stuff-section|$)/g],
];

console.log(`${path} — ${kb(h.length)} raw | ${kb(gzipSync(h).length)} gzip | ${kb(brotliCompressSync(h).length)} brotli`);
console.log(`elements: ~${count(/<[a-zA-Z]/g)} tags, ${count(/<img\b/g)} <img>, ${count(/<button\b/g)} <button>`);
for (const [label, re] of parts) {
    const n = count(re);
    if (n) console.log(`  ${label.padEnd(24)} ${String(n).padStart(4)} × → ${kb(bytes(re)).padStart(9)}  (${((bytes(re) / h.length) * 100).toFixed(0)}%)`);
}
