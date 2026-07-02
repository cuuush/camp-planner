async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function unsubscribeToken(env, person) {
    const secret = env.UNSUB_SECRET || 'camp-planner-dev-secret';
    return sha256Hex(`${person.id}:${person.email}:${secret}`);
}

export async function unsubscribeUrlFor(env, person) {
    const token = await unsubscribeToken(env, person);
    return `https://camp.cuuush.com/unsubscribe/${person.id}/${token}`;
}

export async function verifyUnsubscribeToken(env, person, token) {
    return (await unsubscribeToken(env, person)) === token;
}
