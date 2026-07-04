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

// Returns { emoji, unit } on a usable LLM answer, or null on any failure.
async function fetchItemMetaFromOpenRouter(env, itemName) {
    if (!env.OPENROUTER_API_KEY) return null;

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
                messages: [
                    {
                        role: 'user',
                        content: `You're labeling items on a camping/festival packing list. Pick the single emoji that most specifically depicts the item itself — e.g. "couch" → 🛋️, "tent" → ⛺, "sunscreen" → 🧴, "camp chairs" → 🪑, "beer" → 🍺, "fairy lights" → ✨. Never answer 📦 unless the item literally is a box or package; there is almost always a more specific emoji. For the item "${itemName}", reply with ONLY compact JSON, nothing else: {"emoji":"<one emoji>","unit":"<short plural unit like "packs","cases","sets","chairs","bottles", or "" if it's just counted individually>"}`,
                    },
                ],
            }),
        });

        if (!res.ok) return null;

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim() || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        const emojiMatch = (parsed.emoji || '').match(/\p{Extended_Pictographic}/u);
        if (!emojiMatch) return null;

        const unit = (parsed.unit || '').toString().trim().slice(0, 24);

        return {
            emoji: emojiMatch[0],
            unit: unit.toLowerCase() === 'null' ? FALLBACK_UNIT : unit,
        };
    } catch (e) {
        return null;
    }
}
