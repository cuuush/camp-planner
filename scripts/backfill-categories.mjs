// One-off backfill: assign a category to every existing item that doesn't have
// one yet, using the same LLM categorizer the live "add an item" flow calls
// (src/lib/category.js). Processes festival-by-festival, in item id order, and
// grows each festival's "existing categories" list in memory as it goes — so
// item 40 of a festival can reuse a category item 3 invented, same as it would
// in production, without a D1 round trip per item.
//
// Dry run (prints the plan, writes nothing):
//   node scripts/backfill-categories.mjs --local
//   node scripts/backfill-categories.mjs --remote
//
// Apply for real:
//   node scripts/backfill-categories.mjs --local --apply
//   node scripts/backfill-categories.mjs --remote --apply
//
// Optional --limit N caps how many items get categorized (testing).
//
// Note: this calls fetchCategoryFromOpenRouter directly, bypassing the monthly
// openrouter_text budget that gates the live add-item flow — intentional, you're
// the operator watching the count, but keep --limit handy for big lists.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
const apply = args.includes('--apply');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

if (!target) {
    console.error('Usage: node scripts/backfill-categories.mjs --local|--remote [--apply] [--limit=N]');
    process.exit(1);
}

const key = (await readFile(resolve(root, '.dev.vars'), 'utf8')).match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) {
    console.error('No OPENROUTER_API_KEY in .dev.vars');
    process.exit(1);
}
const env = { OPENROUTER_API_KEY: key };

const { fetchCategoryFromOpenRouter, FALLBACK_CATEGORY } = await import('../src/lib/category.js');

function d1(sql) {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'camp-planner-db', target, '--command', sql, '--json'], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
    });
    // wrangler prints npm update notices above the JSON on some setups — find the array.
    const jsonStart = out.indexOf('[');
    const parsed = JSON.parse(out.slice(jsonStart));
    return parsed[0]?.results || [];
}

console.log(`Reading items from ${target.replace('--', '')} D1...`);
const toCategorize = d1(`
    SELECT id, festival_id, name FROM items
    WHERE deleted_at IS NULL AND (category IS NULL OR category = '')
    ORDER BY festival_id, id
`).slice(0, limit);

const existingRows = d1(`
    SELECT DISTINCT festival_id, category FROM items
    WHERE deleted_at IS NULL AND category IS NOT NULL AND category != ''
`);

if (!toCategorize.length) {
    console.log('Nothing to backfill — every item already has a category.');
    process.exit(0);
}

const existingByFestival = new Map();
for (const row of existingRows) {
    if (!existingByFestival.has(row.festival_id)) existingByFestival.set(row.festival_id, []);
    existingByFestival.get(row.festival_id).push(row.category);
}

console.log(`${toCategorize.length} item(s) need a category across ${new Set(toCategorize.map((r) => r.festival_id)).size} festival(s).\n`);

const plan = [];
for (const item of toCategorize) {
    const existing = existingByFestival.get(item.festival_id) || (existingByFestival.set(item.festival_id, []), existingByFestival.get(item.festival_id));
    const category = (await fetchCategoryFromOpenRouter(env, item.name, existing)) || FALLBACK_CATEGORY;
    if (!existing.includes(category)) existing.push(category);
    plan.push({ ...item, category });
    console.log(`  [f${item.festival_id}] ${item.name.padEnd(32)} -> ${category}`);
}

console.log(`\n${plan.length} item(s) planned.`);

if (!apply) {
    console.log('\nDry run only — rerun with --apply to write these to the database.');
    process.exit(0);
}

const statements = plan.map((p) => `UPDATE items SET category = '${p.category.replace(/'/g, "''")}' WHERE id = ${p.id};`).join('\n');
const dir = await mkdtemp(join(tmpdir(), 'camp-planner-backfill-'));
const file = join(dir, 'backfill-categories.sql');
await writeFile(file, statements + '\n');

console.log(`\nApplying ${plan.length} update(s) to ${target.replace('--', '')} via ${file}...`);
execFileSync('npx', ['wrangler', 'd1', 'execute', 'camp-planner-db', target, `--file=${file}`], { cwd: root, stdio: 'inherit' });
console.log('Done.');
