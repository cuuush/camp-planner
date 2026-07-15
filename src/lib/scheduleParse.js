// Vision-parse a festival set-times poster into structured sets, using OpenRouter
// (Claude Sonnet 5). Same resilience shape as src/lib/emoji.js: ask for structured
// JSON output, fall back to freeform JSON if the provider rejects response_format,
// and never throw — a failure returns null and the caller degrades politely.
//
// The hard part is the clock: festival posters print times with no am/pm and wrap
// past midnight, so "12:00" means noon near the top of the ruler and midnight near
// the bottom. We push that disambiguation onto the model (it can see the ruler) and
// ask for minutes-from-midnight, with after-midnight times as 1440+ so a single
// number line orders the whole night correctly.
//
// Two things about the request that look odd and aren't:
//
//  • No `temperature`. Extended thinking is on, and Anthropic only accepts
//    temperature=1 with it — so sending our old temperature:0 is asking for a 400 on
//    any route that enforces it. Thinking is worth more than the determinism here.
//  • max_tokens is 8000, not the 4000 it needs for the answer. `effort` spends a
//    FRACTION of max_tokens on thinking, so the reasoning and the JSON come out of
//    one pot — leaving 4000 would let a long think starve a 74-set poster mid-array.
//
// Measured on the 3.2MB Elements Friday poster (scripts/probe-thinking.mjs): thinking
// composes fine with the strict schema and costs nothing in accuracy, but it also
// didn't CHANGE anything — 37 sets with and without, and Sonnet only spends ~80-150
// reasoning tokens even when handed a large budget. It's cheap insurance for a
// messier poster, not a fix for a known miss.

const SCHEDULE_MODEL = 'anthropic/claude-sonnet-5';

// A festival never realistically runs longer than "late morning → ~6am next day",
// so anything outside this window is a misread we drop rather than draw off-grid.
const MIN_ALLOWED = 0;        // midnight
const MAX_ALLOWED = 30 * 60;  // 6:00 AM the next day (1440 + 360)

const SCHEDULE_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'festival_schedule',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                day: { type: 'string', description: 'the day label printed on the poster, e.g. "Friday", or "" if none' },
                sets: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            stage: { type: 'string', description: 'the column / stage heading this set sits under' },
                            artist: { type: 'string', description: 'the performer name exactly as printed' },
                            start_min: { type: 'integer', description: 'start time in minutes from midnight; after-midnight times are 1440+' },
                            end_min: { type: 'integer', description: 'end time in minutes from midnight; after-midnight times are 1440+' },
                        },
                        required: ['stage', 'artist', 'start_min', 'end_min'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['day', 'sets'],
            additionalProperties: false,
        },
    },
};

const PROMPT = `You are reading a music festival's set-times poster. The festival has several STAGES shown as columns, each with a heading (a stage or area name). Time runs DOWN a vertical ruler along the left edge; every set is a block showing an artist and a start-end time.

The ruler's clock has NO am/pm and wraps past midnight: it begins in the late morning or around noon at the TOP and continues through the evening and past midnight into the early morning at the BOTTOM. Use each block's vertical position against the ruler to decide whether a printed time like "12:00" or "1:00" means midday or after midnight.

For every set on the poster, report:
- "stage": the column/stage heading it sits under (e.g. "Earth", "Fire").
- "artist": the performer name exactly as printed (keep "b2b" and "+" pairings together on one line).
- "start_min" and "end_min": integer minutes from midnight of the festival's calendar day. Times in the early morning AFTER midnight are 1440 + minutes. Reference points: 11:00 AM = 660, 12:00 noon = 720, 3:30 PM = 930, 11:15 PM = 1395, 12:30 AM = 1470, 2:00 AM = 1560.

Also report "day": the day label printed on the poster (e.g. "Friday"), or "" if none is shown.

List EVERY set on the poster. Go column by column, LEFT TO RIGHT across the stages as they appear on the poster, and within each stage from earliest to latest — so the order you list stages in matches their left-to-right column order.

Reply with ONLY the JSON, in exactly this shape:

{"day":"Friday","sets":[{"stage":"Earth","artist":"NEEK.O","start_min":1395,"end_min":1470}]}`;

// Returns { day, sets: [{ stage, artist, start_min, end_min }] } on success, or
// null on any failure. Two structured-output attempts, then one freeform attempt —
// if the routed provider rejects response_format (4xx) only dropping it can succeed.
export async function parseScheduleImage(apiKey, dataUrl) {
    if (!apiKey || !dataUrl) return null;

    let useSchema = true;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt === 2) useSchema = false;
        try {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: SCHEDULE_MODEL,
                    max_tokens: 8000,
                    reasoning: { effort: 'medium' },
                    ...(useSchema ? { response_format: SCHEDULE_RESPONSE_FORMAT } : {}),
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: PROMPT },
                                { type: 'image_url', image_url: { url: dataUrl } },
                            ],
                        },
                    ],
                }),
            });

            if (!res.ok) {
                if (useSchema && res.status >= 400 && res.status < 500) useSchema = false;
                continue;
            }

            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content?.trim() || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;

            const parsed = JSON.parse(jsonMatch[0]);
            const sets = normalizeParsedSets(parsed.sets);
            if (!sets.length) continue;
            return { day: (parsed.day || '').toString().trim(), sets };
        } catch (e) {
            // network hiccup, non-JSON body, malformed JSON — retry
        }
    }
    return null;
}

// Clean the model's raw set list into rows we're willing to store: a non-empty
// artist, sane numeric times, end after start. stage_order preserves the poster's
// LEFT-TO-RIGHT column order (first appearance = column index), so the grid keeps
// Earth, Fire, Air, Water rather than re-alphabetizing them. Sorted by that column
// order then start so the preview and seed read like the poster.
export function normalizeParsedSets(rawSets) {
    if (!Array.isArray(rawSets)) return [];
    const stageOrder = new Map();
    const clean = [];
    for (const s of rawSets) {
        const artist = (s && s.artist ? s.artist : '').toString().trim().slice(0, 120);
        const stage = (s && s.stage ? s.stage : '').toString().trim().slice(0, 60);
        let start = Number(s && s.start_min);
        let end = Number(s && s.end_min);
        if (!artist || !Number.isFinite(start) || !Number.isFinite(end)) continue;
        start = Math.round(start);
        end = Math.round(end);
        // A block that ends "before" it starts wrapped past midnight (e.g. 11:15 PM
        // → 12:30 AM read as 1395 → 30): nudge the end into the next day.
        if (end <= start) end += 1440;
        if (start < MIN_ALLOWED || start > MAX_ALLOWED || end > MAX_ALLOWED + 1440) continue;
        if (!stageOrder.has(stage)) stageOrder.set(stage, stageOrder.size);
        clean.push({ stage, stage_order: stageOrder.get(stage), artist, start_min: start, end_min: end });
    }
    clean.sort((a, b) => a.stage_order - b.stage_order || a.start_min - b.start_min);
    return clean;
}
