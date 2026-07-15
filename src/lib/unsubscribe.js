// Unsubscribe links are HMAC-SHA256 tokens over "id:email". The secret is
// REQUIRED: with no UNSUB_SECRET there is no unforgeable link to put in an
// e-mail, so token minting returns null (notify.js then skips sending) and
// verification always fails. No dev-secret fallback — a guessable default in
// prod would let anyone who knows a person's id + e-mail unsubscribe them.

async function hmacHex(secret, text) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compare every character regardless of where the first mismatch is, so the
// check's timing can't be used to guess a token byte by byte.
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export async function unsubscribeToken(env, person) {
    if (!env.UNSUB_SECRET) return null;
    return hmacHex(env.UNSUB_SECRET, `${person.id}:${person.email}`);
}

// Null when no secret is configured — callers must treat that as "can't send".
export async function unsubscribeUrlFor(env, person) {
    const token = await unsubscribeToken(env, person);
    return token ? `https://camp.cuuush.com/unsubscribe/${person.id}/${token}` : null;
}

export async function verifyUnsubscribeToken(env, person, token) {
    if (!env.UNSUB_SECRET || !token) return false;
    const expected = await unsubscribeToken(env, person);
    if (timingSafeEqual(token, expected)) return true;
    // Links in e-mails sent before the HMAC switch used sha256(id:email:secret).
    // Honor them (real secret only) so old unsubscribe links keep working.
    const legacy = await sha256Hex(`${person.id}:${person.email}:${env.UNSUB_SECRET}`);
    return timingSafeEqual(token, legacy);
}
