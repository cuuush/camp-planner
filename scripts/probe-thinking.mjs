// Throwaway probe: does enabling extended thinking on Sonnet 5 (via OpenRouter's
// `reasoning` param) actually work alongside our strict json_schema structured
// output — and does it read the poster any better?
//
// Things that could bite and are worth MEASURING rather than assuming:
//  • Anthropic rejects temperature != 1 when extended thinking is on. We send
//    temperature: 0 today. Does OpenRouter pass that through as an error?
//  • `effort` is a fraction of max_tokens, so thinking eats the same budget the
//    answer needs. 74 sets of JSON is not small.
//  • structured outputs + thinking may or may not compose.
//
// Run: node scripts/probe-thinking.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const key = (await readFile(resolve(root, '.dev.vars'), 'utf8')).match(/^OPENROUTER_API_KEY=(.+)$/m)[1].trim();
const buf = await readFile(resolve(here, 'elements-friday-sample.png'));
const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;

const { default: mod } = await import('../src/lib/scheduleParse.js').then((m) => ({ default: m }));

// Rebuild the exact request the app sends, so the probe tests OUR shape.
const SCHEMA = {
    type: 'json_schema',
    json_schema: {
        name: 'festival_schedule', strict: true,
        schema: {
            type: 'object',
            properties: {
                day: { type: 'string' },
                sets: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            stage: { type: 'string' }, artist: { type: 'string' },
                            start_min: { type: 'integer' }, end_min: { type: 'integer' },
                        },
                        required: ['stage', 'artist', 'start_min', 'end_min'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['day', 'sets'], additionalProperties: false,
        },
    },
};

const PROMPT = `You are reading a music festival's set-times poster. The festival has several STAGES shown as columns, each with a heading. Time runs DOWN a vertical ruler along the left edge; every set is a block showing an artist and a start-end time.

The ruler's clock has NO am/pm and wraps past midnight. Use each block's vertical position against the ruler to decide whether a printed time like "12:00" or "1:00" means midday or after midnight.

For every set report "stage", "artist" (exactly as printed, keep "b2b" and "+" pairings together), and "start_min"/"end_min" as integer minutes from midnight (after-midnight = 1440 + minutes; 11:00 AM = 660, 12:00 noon = 720, 11:15 PM = 1395, 12:30 AM = 1470, 2:00 AM = 1560). Also report "day". Reply with ONLY the JSON.`;

async function attempt(label, extra) {
    const t0 = Date.now();
    let res, data;
    try {
        res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'anthropic/claude-sonnet-5',
                max_tokens: 8000,
                response_format: SCHEMA,
                messages: [{ role: 'user', content: [
                    { type: 'text', text: PROMPT },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ] }],
                ...extra,
            }),
        });
        data = await res.json();
    } catch (e) {
        console.log(`${label.padEnd(34)} THREW ${e.message}`);
        return;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!res.ok || data.error) {
        console.log(`${label.padEnd(34)} HTTP ${res.status} — ${JSON.stringify(data.error?.message || data).slice(0, 150)}`);
        return;
    }
    const msg = data.choices?.[0]?.message;
    const text = (msg?.content || '').trim();
    let sets = null;
    try { sets = JSON.parse(text.match(/\{[\s\S]*\}/)[0]).sets.length; } catch (e) {}
    const u = data.usage || {};
    console.log(`${label.padEnd(34)} ${secs}s  sets=${sets ?? 'PARSE-FAIL'}  ` +
        `reasoning_tokens=${u.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  ` +
        `completion=${u.completion_tokens ?? '?'}  finish=${data.choices?.[0]?.finish_reason}`);
}

console.log(`poster ${(buf.length / 1024 / 1024).toFixed(1)} MB, max_tokens 8000, strict json_schema\n`);
await attempt('baseline (temp 0, no thinking)', { temperature: 0 });
await attempt('thinking medium + temp 0', { temperature: 0, reasoning: { effort: 'medium' } });
await attempt('thinking medium, no temp', { reasoning: { effort: 'medium' } });
