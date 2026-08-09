function normalizeIdentifier(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

export function snapshotAccountToken(tokenObj) {
    const id = normalizeIdentifier(tokenObj?.id);
    const token = typeof tokenObj?.token === 'string' ? tokenObj.token : null;
    if (!id || !token) return null;
    return Object.freeze({ id, token });
}

export function createAccountAffinityRegistry({ maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
        throw new RangeError('maxEntries must be a positive integer');
    }
    const accountByResource = new Map();

    return Object.freeze({
        bind(resourceId, accountId) {
            const normalizedResourceId = normalizeIdentifier(resourceId);
            const normalizedAccountId = normalizeIdentifier(accountId);
            if (!normalizedResourceId || !normalizedAccountId) return false;

            const existingAccountId = accountByResource.get(normalizedResourceId);
            if (existingAccountId && existingAccountId !== normalizedAccountId) return false;

            if (!existingAccountId && accountByResource.size >= maxEntries) {
                const oldestResourceId = accountByResource.keys().next().value;
                accountByResource.delete(oldestResourceId);
            }
            accountByResource.set(normalizedResourceId, normalizedAccountId);
            return true;
        },

        get(resourceId) {
            const normalizedResourceId = normalizeIdentifier(resourceId);
            return normalizedResourceId ? accountByResource.get(normalizedResourceId) || null : null;
        },

        forget(resourceId) {
            const normalizedResourceId = normalizeIdentifier(resourceId);
            return normalizedResourceId ? accountByResource.delete(normalizedResourceId) : false;
        }
    });
}

export async function resolveChatRequestContext({
    chatId = null,
    parentId = null,
    affinityRegistry,
    getAccountToken,
    selectToken
}) {
    if (!affinityRegistry || typeof affinityRegistry.get !== 'function') {
        throw new TypeError('affinityRegistry is required');
    }
    if (typeof getAccountToken !== 'function' || typeof selectToken !== 'function') {
        throw new TypeError('getAccountToken and selectToken must be functions');
    }

    const normalizedChatId = normalizeIdentifier(chatId);
    const normalizedParentId = normalizeIdentifier(parentId);
    const boundAccountId = affinityRegistry.get(normalizedChatId);

    if (boundAccountId) {
        const boundToken = snapshotAccountToken(await getAccountToken(boundAccountId));
        if (boundToken) {
            return Object.freeze({
                accountId: boundToken.id,
                token: boundToken.token,
                chatId: normalizedChatId,
                parentId: normalizedParentId,
                reusedChat: true,
                resetReason: null
            });
        }
        affinityRegistry.forget(normalizedChatId);
    }

    const selectedToken = snapshotAccountToken(await selectToken());
    if (!selectedToken) return null;

    return Object.freeze({
        accountId: selectedToken.id,
        token: selectedToken.token,
        chatId: null,
        parentId: null,
        reusedChat: false,
        resetReason: normalizedChatId
            ? (boundAccountId ? 'bound_account_unavailable' : 'unknown_chat_affinity')
            : null
    });
}
