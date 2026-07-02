export function normalizeName(name) {
    return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
