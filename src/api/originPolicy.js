export function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch {
        return value;
    }
}

export function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1';
}

export function parseAllowedOrigins(value) {
    return new Set(String(value || '')
        .split(',')
        .map(normalizeOrigin)
        .filter(Boolean));
}

export function isBrowserOriginAllowed(origin, allowedOrigins = new Set()) {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHostname(parsed.hostname);
    } catch {
        return false;
    }
}
