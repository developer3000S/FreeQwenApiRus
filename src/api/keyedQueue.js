import crypto from 'crypto';

function normalizeKey(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

export function createScopedConversationAlias(value, clientScope, namespace = 'client-conversation') {
    const normalizedValue = normalizeKey(value);
    const normalizedScope = normalizeKey(clientScope);
    const normalizedNamespace = normalizeKey(namespace);
    if (!normalizedValue || !normalizedScope || !normalizedNamespace) return null;

    const hash = crypto
        .createHash('sha256')
        .update(`${normalizedNamespace}:${normalizedScope}:${normalizedValue}`)
        .digest('hex')
        .substring(0, 16);
    return `chat_${hash}`;
}

export function fingerprintClientCredential(value) {
    const normalizedValue = normalizeKey(value);
    if (!normalizedValue) return null;
    return crypto.createHash('sha256').update(normalizedValue).digest('hex');
}

export function matchesClientCredential(candidate, allowedCredentials = []) {
    const normalizedCandidate = normalizeKey(candidate);
    if (!normalizedCandidate || !Array.isArray(allowedCredentials)) return false;
    const candidateBuffer = Buffer.from(normalizedCandidate);
    let matched = false;
    for (const allowed of allowedCredentials) {
        const normalizedAllowed = normalizeKey(allowed);
        if (!normalizedAllowed) continue;
        const allowedBuffer = Buffer.from(normalizedAllowed);
        if (candidateBuffer.length !== allowedBuffer.length) continue;
        matched = crypto.timingSafeEqual(candidateBuffer, allowedBuffer) || matched;
    }
    return matched;
}

export function createClientScope({ ip, userAgent, credentialFingerprint = null } = {}) {
    const normalizedIp = normalizeKey(ip) || 'unknown';
    const normalizedUserAgent = normalizeKey(userAgent) || 'unknown';
    const normalizedFingerprint = normalizeKey(credentialFingerprint) || 'public';
    return crypto
        .createHash('sha256')
        .update(`${normalizedIp}||${normalizedUserAgent}||${normalizedFingerprint}`)
        .digest('hex');
}

export function scopeClientChatIdentity(value, clientScope) {
    const normalizedValue = normalizeKey(value);
    if (!normalizedValue) return null;
    return createScopedConversationAlias(`client-chat:${normalizedValue}`, clientScope);
}

export function canonicalizeConversationKey(value, resolveAlias) {
    const normalizedValue = normalizeKey(value);
    if (!normalizedValue) return null;
    const resolved = typeof resolveAlias === 'function' ? normalizeKey(resolveAlias(normalizedValue)) : null;
    return resolved || normalizedValue;
}

export function createConversationIdentityRegistry({ maxResources = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxResources) || maxResources < 2) {
        throw new RangeError('maxResources must be an integer greater than one');
    }

    const lockKeyByResource = new Map();
    const resourcesByLockKey = new Map();
    const currentUpstreamByLockKey = new Map();

    function removeResourceFromGroup(resourceId, lockKey) {
        const resources = resourcesByLockKey.get(lockKey);
        if (!resources) return;
        resources.delete(resourceId);
        if (resources.size === 0) resourcesByLockKey.delete(lockKey);
    }

    function registerResource(resourceId, lockKey) {
        if (!resourceId || !lockKey) return;
        const previousLockKey = lockKeyByResource.get(resourceId);
        if (previousLockKey && previousLockKey !== lockKey) {
            removeResourceFromGroup(resourceId, previousLockKey);
        }
        lockKeyByResource.set(resourceId, lockKey);
        let resources = resourcesByLockKey.get(lockKey);
        if (!resources) resources = new Set();
        resources.add(resourceId);
        resourcesByLockKey.delete(lockKey);
        resourcesByLockKey.set(lockKey, resources);
    }

    function mergeLockGroup(sourceLockKey, targetLockKey) {
        if (!sourceLockKey || sourceLockKey === targetLockKey) return;
        const sourceResources = resourcesByLockKey.get(sourceLockKey);
        if (!sourceResources) return;
        for (const resourceId of [...sourceResources]) {
            registerResource(resourceId, targetLockKey);
        }
        resourcesByLockKey.delete(sourceLockKey);
        currentUpstreamByLockKey.delete(sourceLockKey);
    }

    function trim() {
        while (lockKeyByResource.size > maxResources && resourcesByLockKey.size > 0) {
            const [oldestLockKey, resources] = resourcesByLockKey.entries().next().value;
            resourcesByLockKey.delete(oldestLockKey);
            currentUpstreamByLockKey.delete(oldestLockKey);
            for (const resourceId of resources) {
                if (lockKeyByResource.get(resourceId) === oldestLockKey) {
                    lockKeyByResource.delete(resourceId);
                }
            }
        }
    }

    return Object.freeze({
        map(aliasValue, upstreamValue, { compareCurrent = false, expectedCurrent = null } = {}) {
            const alias = normalizeKey(aliasValue);
            const upstreamId = normalizeKey(upstreamValue);
            if (!alias || !upstreamId) return false;

            const aliasLockKey = lockKeyByResource.get(alias);
            const currentUpstreamId = aliasLockKey
                ? currentUpstreamByLockKey.get(aliasLockKey) || null
                : null;
            const normalizedExpected = normalizeKey(expectedCurrent);
            if (compareCurrent && currentUpstreamId !== normalizedExpected) return false;

            // A known upstream/tombstone already belongs to a conversation
            // group. Its current target wins, so stale ids cannot move the
            // conversation backwards or create a one-hop alias chain.
            const upstreamLockKey = lockKeyByResource.get(upstreamId);
            const canonicalUpstreamId = upstreamLockKey
                ? currentUpstreamByLockKey.get(upstreamLockKey) || upstreamId
                : upstreamId;
            const stableLockKey = upstreamLockKey || aliasLockKey || alias;

            mergeLockGroup(aliasLockKey, stableLockKey);
            registerResource(alias, stableLockKey);
            registerResource(upstreamId, stableLockKey);
            registerResource(canonicalUpstreamId, stableLockKey);
            currentUpstreamByLockKey.set(stableLockKey, canonicalUpstreamId);
            trim();
            return true;
        },

        resolve(resourceValue) {
            const resourceId = normalizeKey(resourceValue);
            if (!resourceId) return null;
            const lockKey = lockKeyByResource.get(resourceId);
            return lockKey ? currentUpstreamByLockKey.get(lockKey) || null : null;
        },

        has(resourceValue) {
            const resourceId = normalizeKey(resourceValue);
            return resourceId ? lockKeyByResource.has(resourceId) : false;
        },

        lockKey(resourceValue) {
            const resourceId = normalizeKey(resourceValue);
            if (!resourceId) return null;
            const stableLockKey = lockKeyByResource.get(resourceId);
            if (!stableLockKey) return resourceId;
            const resources = resourcesByLockKey.get(stableLockKey);
            if (resources) {
                resourcesByLockKey.delete(stableLockKey);
                resourcesByLockKey.set(stableLockKey, resources);
            }
            return stableLockKey;
        },

        get resourceCount() {
            return lockKeyByResource.size;
        }
    });
}

/**
 * A small in-memory FIFO lock keyed by an upstream conversation identifier.
 * Requests for different conversations still run in parallel.
 */
export function createKeyedQueue() {
    const tails = new Map();

    return Object.freeze({
        async acquire(key) {
            const normalizedKey = normalizeKey(key);
            if (!normalizedKey) return () => {};

            const previous = tails.get(normalizedKey) || Promise.resolve();
            let releaseGate;
            const gate = new Promise(resolve => { releaseGate = resolve; });
            const tail = previous.catch(() => {}).then(() => gate);
            tails.set(normalizedKey, tail);

            await previous.catch(() => {});

            let released = false;
            return () => {
                if (released) return;
                released = true;
                releaseGate();
                tail.finally(() => {
                    if (tails.get(normalizedKey) === tail) tails.delete(normalizedKey);
                });
            };
        },

        get size() {
            return tails.size;
        }
    });
}
