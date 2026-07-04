const FALLBACK_EMOJI = '📦';
const FALLBACK_UNIT = '';

// Never blocks item creation — any failure just falls back to a box + no unit.
export async function getItemMeta(env, itemName) {
    const key = itemName.trim().toLowerCase();
    if (!key) return { emoji: FALLBACK_EMOJI, unit: FALLBACK_UNIT };

    try {
        const cached = await env.DB.prepare('SELECT emoji, unit FROM emoji_cache WHERE normalized_name = ?').bind(key).first();
        // A cached 📦 may be a stale fallback from before we stopped caching
        // failures — treat it as a miss so old entries heal on next use.
        if (cached && cached.emoji !== FALLBACK_EMOJI) return { emoji: cached.emoji, unit: cached.unit || FALLBACK_UNIT };
    } catch (e) {
        // fall through to LLM / fallback
    }

    const meta = await fetchItemMetaFromOpenRouter(env, itemName);
    if (!meta) return { emoji: FALLBACK_EMOJI, unit: FALLBACK_UNIT };

    // Only cache real LLM answers, and never cache 📦 — otherwise one flaky
    // call pins the fallback to this item name forever.
    if (meta.emoji !== FALLBACK_EMOJI) {
        try {
            await env.DB.prepare('INSERT OR REPLACE INTO emoji_cache (normalized_name, emoji, unit) VALUES (?, ?, ?)')
                .bind(key, meta.emoji, meta.unit).run();
        } catch (e) {
            // caching is best-effort
        }
    }

    return meta;
}

// OpenRouter structured output: forces the model to emit exactly this shape,
// so we're not at the mercy of it remembering to reply with bare JSON.
const ITEM_META_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'item_meta',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                emoji: { type: 'string', description: 'the single emoji that best depicts the item' },
                unit: { type: 'string', description: 'short plural unit like "packs" or "cases", or "" if counted individually' },
            },
            required: ['emoji', 'unit'],
            additionalProperties: false,
        },
    },
};

// Returns { emoji, unit } on a usable LLM answer, or null on any failure.
// Two attempts with structured output, then a last freeform attempt — if the
// routed provider rejects response_format (4xx), only dropping it can succeed.
async function fetchItemMetaFromOpenRouter(env, itemName) {
    if (!env.OPENROUTER_API_KEY) return null;

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
                    ...(useSchema ? { response_format: ITEM_META_RESPONSE_FORMAT } : {}),
                    messages: [
                        {
                            role: 'user',
                            content: `You're labeling items on a camping/festival packing list. Pick the single emoji that most specifically depicts the item itself — e.g. "couch" → 🛋️, "tent" → ⛺, "sunscreen" → 🧴, "camp chairs" → 🪑, "beer" → 🍺, "fairy lights" → ✨. Never answer 📦 unless the item literally is a box or package; there is almost always a more specific emoji. For the item "${itemName}", reply with ONLY compact JSON, nothing else: {"emoji":"<one emoji>","unit":"<short plural unit like "packs","cases","sets","chairs","bottles", or "" if it's just counted individually>"}`,
                        },
                    ],
                }),
            });

            if (!res.ok) {
                // 4xx while sending a schema is likely "response_format not
                // supported" from the routed provider — go freeform next try.
                if (useSchema && res.status >= 400 && res.status < 500) useSchema = false;
                continue;
            }

            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content?.trim() || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;

            const parsed = JSON.parse(jsonMatch[0]);
            const emojiMatch = (parsed.emoji || '').match(/\p{Extended_Pictographic}/u);
            if (!emojiMatch) continue;

            const unit = (parsed.unit || '').toString().trim().slice(0, 24);

            return {
                emoji: emojiMatch[0],
                unit: unit.toLowerCase() === 'null' ? FALLBACK_UNIT : unit,
            };
        } catch (e) {
            // network hiccup or invalid JSON in the body — retry
        }
    }
    return null;
}
