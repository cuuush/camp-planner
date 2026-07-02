const FALLBACK_EMOJI = '📦';

// Never blocks item creation — any failure just falls back to a box.
export async function getEmojiForItem(env, itemName) {
    const key = itemName.trim().toLowerCase();
    if (!key) return FALLBACK_EMOJI;

    try {
        const cached = await env.DB.prepare('SELECT emoji FROM emoji_cache WHERE normalized_name = ?').bind(key).first();
        if (cached) return cached.emoji;
    } catch (e) {
        // fall through to LLM / fallback
    }

    const emoji = await fetchEmojiFromOpenRouter(env, itemName);

    try {
        await env.DB.prepare('INSERT OR REPLACE INTO emoji_cache (normalized_name, emoji) VALUES (?, ?)')
            .bind(key, emoji).run();
    } catch (e) {
        // caching is best-effort
    }

    return emoji;
}

async function fetchEmojiFromOpenRouter(env, itemName) {
    if (!env.OPENROUTER_API_KEY) return FALLBACK_EMOJI;

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
                max_tokens: 6,
                messages: [
                    {
                        role: 'user',
                        content: `Reply with exactly one emoji that best represents this camping/festival item, nothing else, no words: "${itemName}"`,
                    },
                ],
            }),
        });

        if (!res.ok) return FALLBACK_EMOJI;

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim() || '';
        const match = text.match(/\p{Extended_Pictographic}/u);
        return match ? match[0] : FALLBACK_EMOJI;
    } catch (e) {
        return FALLBACK_EMOJI;
    }
}
