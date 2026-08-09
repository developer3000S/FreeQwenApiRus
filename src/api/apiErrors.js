export function getApiResultStatus(result, fallbackStatus = 500) {
    const explicitStatus = Number(result?.status);
    if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) {
        return explicitStatus;
    }
    if (result?.invalidRequest) return 400;
    if (result?.reuploadRequired) return 409;
    return fallbackStatus;
}

export function sendApiResultError(res, result, { openAI = false } = {}) {
    const status = getApiResultStatus(result);
    const message = result?.error || 'Внутренняя ошибка сервера';
    if (!res.headersSent && typeof res.removeHeader === 'function') {
        for (const header of [
            'Transfer-Encoding',
            'Cache-Control',
            'Pragma',
            'Expires',
            'Connection',
            'X-Accel-Buffering'
        ]) {
            res.removeHeader(header);
        }
    }
    if (!res.headersSent && typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    if (openAI) {
        return res.status(status).json({
            error: {
                message,
                type: status < 500 ? 'invalid_request_error' : 'server_error'
            }
        });
    }
    return res.status(status).json({ error: message });
}
