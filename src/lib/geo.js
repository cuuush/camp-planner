export function requestMeta(c) {
    const cf = c.req.raw.cf || {};
    return {
        ip: c.req.header('cf-connecting-ip') || '',
        city: cf.city || '',
        country: cf.country || '',
        userAgent: c.req.header('user-agent') || '',
    };
}
