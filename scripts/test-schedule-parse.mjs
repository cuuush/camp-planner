// Manual de-risk harness for the schedule vision parser. Reads the OpenRouter key
// from .dev.vars, sends a poster image to Claude Sonnet 5, and prints the parsed
// sets grouped by stage so we can eyeball the am/pm-past-midnight reasoning before
// wiring any UI.
//
//   node scripts/test-schedule-parse.mjs [path/to/image.png]
//
// Defaults to the Elements Friday sample copied into scripts/.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseScheduleImage } from '../src/lib/scheduleParse.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readKey() {
    return readFile(resolve(root, '.dev.vars'), 'utf8').then((txt) => {
        const m = txt.match(/^OPENROUTER_API_KEY=(.+)$/m);
        if (!m) throw new Error('OPENROUTER_API_KEY not found in .dev.vars');
        return m[1].trim();
    });
}

function fmt(min) {
    const wrapped = min % 1440;
    let h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const day = min >= 1440 ? ' (+1)' : '';
    return `${h}:${String(m).padStart(2, '0')} ${ap}${day}`;
}

const imgPath = process.argv[2] || resolve(here, 'elements-friday-sample.png');

const [key, buf] = await Promise.all([readKey(), readFile(imgPath)]);
const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;

console.log(`Parsing ${imgPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB) with Sonnet 5…\n`);
const t0 = Date.now();
const result = await parseScheduleImage(key, dataUrl);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (!result) {
    console.error(`FAILED to parse (after ${secs}s).`);
    process.exit(1);
}

console.log(`day: ${JSON.stringify(result.day)} — ${result.sets.length} sets in ${secs}s\n`);
const byStage = new Map();
for (const s of result.sets) {
    if (!byStage.has(s.stage)) byStage.set(s.stage, []);
    byStage.get(s.stage).push(s);
}
for (const [stage, sets] of byStage) {
    console.log(`── ${stage} ──`);
    for (const s of sets) {
        console.log(`   ${fmt(s.start_min)} – ${fmt(s.end_min)}  ${s.artist}`);
    }
    console.log('');
}
