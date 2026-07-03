// D1 occasionally throws this when its backing storage object gets reset/evicted;
// it's a transient Cloudflare-side hiccup that normally clears within a request or two.
const D1_RESET_ERROR = /D1_ERROR.*object to be reset/i;

export function isD1ResetError(err) {
    return D1_RESET_ERROR.test(String(err?.message ?? err));
}

export async function retryOnD1Reset(fn, { attempts = 3, delayMs = 250 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isD1ResetError(err) || i === attempts - 1) throw err;
            await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
        }
    }
    throw lastErr;
}
