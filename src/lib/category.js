import { takeApiBudget, OPENROUTER_TEXT_MONTHLY_LIMIT } from './budget.js';

const FALLBACK_CATEGORY = 'Miscellaneous';

// Never blocks item creation — any failure just falls back to Miscellaneous, same
// philosophy as getItemMeta() in emoji.js.
export async function getItemCategory(env, db, festivalId, itemName) {
    const name = (itemName || '').toString().trim();
    if (!name) return FALLBACK_CATEGORY;

    let existing = [];
    try {
        const { results } = await db.prepare(`
            SELECT DISTINCT category FROM items
            WHERE festival_id = ? AND deleted_at IS NULL AND category IS NOT NULL AND category != ''
            ORDER BY category COLLATE NOCASE
        `).bind(festivalId).all();
        existing = (results || []).map((r) => r.category);
    } catch (e) {
        // fall through with an empty list — worst case the LLM invents a fresh one
    }

    // Monthly budget (D1-backed, shared across isolates): once spent, new items
    // land in Miscellaneous until next month. Never blocks item creation.
    try {
        if (db && !await takeApiBudget(db, 'openrouter_text', OPENROUTER_TEXT_MONTHLY_LIMIT)) {
            return FALLBACK_CATEGORY;
        }
    } catch (e) {
        return FALLBACK_CATEGORY;
    }

    const category = await fetchCategoryFromOpenRouter(env, name, existing);
    return category || FALLBACK_CATEGORY;
}

export { FALLBACK_CATEGORY, fetchCategoryFromOpenRouter };

const ITEM_CATEGORY_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'item_category',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                category: { type: 'string', description: 'the best-fit category name for this item' },
            },
            required: ['category'],
            additionalProperties: false,
        },
    },
};

// Returns a category string on a usable LLM answer, or null on any failure. Same
// three-attempt shape as fetchItemMetaFromOpenRouter: two tries with structured
// output, then one freeform try in case the routed provider rejects response_format.
async function fetchCategoryFromOpenRouter(env, itemName, existingCategories) {
    if (!env.OPENROUTER_API_KEY) return null;

    const categoryList = existingCategories.length
        ? existingCategories.map((c) => `"${c}"`).join(', ')
        : '(none yet — this is the first item on the list)';

    let useSchema = true;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt === 2) useSchema = false;
        try {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'deepseek/deepseek-v4-flash',
                    reasoning: { enabled: false },
                    max_tokens: 40,
                    temperature: 0,
                    ...(useSchema ? { response_format: ITEM_CATEGORY_RESPONSE_FORMAT } : {}),
                    messages: [
                        {
                            role: 'user',
                            content: `You're organizing a camping/festival packing list into categories, like Windows Explorer's "group by" view.

Rules:
- Reuse an existing category (spelled EXACTLY as given) ONLY if the item is a clear, obvious member of it by everyday meaning — not just because it happens to be the only one available.
- Never reuse a category that's a joke, junk, or too vague to mean anything (e.g. "poop", "misc", "stuff", "other", a single item's own name) — invent a real one instead.
- If nothing existing is a strong fit, invent a new short category: Title Case, 1-3 words (e.g. "Kitchen Gear", "Shelter", "Lighting & Power", "Games & Activities", "Comfort", "Toiletries & Safety", "Music Gear"). New categories are common and expected — most lists need several.

Existing categories already on this list: ${categoryList}

Item: "${itemName}"

Reply with ONLY compact JSON, nothing else: {"category":"<category name>"}`,
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
            const category = (parsed.category || '').toString().trim().slice(0, 40);
            if (!category) continue;

            return category;
        } catch (e) {
            // network hiccup or invalid JSON in the body — retry
        }
    }
    return null;
}
