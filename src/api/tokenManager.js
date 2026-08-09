import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_PATH = path.resolve(__dirname, '..', '..', SESSION_DIR);
const ACCOUNTS_PATH = path.join(SESSION_PATH, ACCOUNTS_DIR);
const TOKENS_FILE = path.join(SESSION_PATH, 'tokens.json');

let pointer = 0;

function isAvailableToken(token, now = Date.now()) {
    return Boolean(token?.token)
        && token.invalid !== true
        && (!token.resetAt || new Date(token.resetAt).getTime() <= now);
}

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_PATH)) fs.mkdirSync(ACCOUNTS_PATH, { recursive: true });
}

export function loadTokens() {
    ensureSessionDir();
    if (!fs.existsSync(TOKENS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    } catch (e) {
        logError('TokenManager: ошибка чтения tokens.json', e);
        return [];
    }
}

export function saveTokens(tokens) {
    ensureSessionDir();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (e) {
        logError('TokenManager: ошибка сохранения tokens.json', e);
    }
}

export async function getAvailableToken() {
    const tokens = loadTokens();
    const now = Date.now();
    const valid = tokens.filter(token => isAvailableToken(token, now));
    if (!valid.length) return null;
    const token = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return token;
}

export function getAvailableTokenById(id) {
    if (!id) return null;
    const token = loadTokens().find(candidate => candidate.id === id);
    return isAvailableToken(token) ? token : null;
}

export function hasValidTokens() {
    const tokens = loadTokens();
    const now = Date.now();
    return tokens.some(token => isAvailableToken(token, now));
}

export function markRateLimited(id, hours = 24) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        saveTokens(tokens);
    }
}

export function markRateLimitedByToken(tokenValue, hours = 24) {
    if (typeof tokenValue !== 'string' || !tokenValue) return 0;
    const tokens = loadTokens();
    const resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    let updated = 0;
    for (const token of tokens) {
        if (token.token === tokenValue) {
            token.resetAt = resetAt;
            updated++;
        }
    }
    if (updated > 0) saveTokens(tokens);
    return updated;
}

export function removeToken(id) {
    saveTokens(loadTokens().filter(t => t.id !== id));
}

export { removeToken as removeInvalidToken };

export function markInvalid(id) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) { tokens[idx].invalid = true; saveTokens(tokens); }
}

export function markInvalidByToken(tokenValue) {
    if (typeof tokenValue !== 'string' || !tokenValue) return 0;
    const tokens = loadTokens();
    let updated = 0;
    for (const token of tokens) {
        if (token.token === tokenValue) {
            token.invalid = true;
            updated++;
        }
    }
    if (updated > 0) saveTokens(tokens);
    return updated;
}

export function markValid(id, newToken) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].invalid = false;
        tokens[idx].resetAt = null;
        if (newToken) tokens[idx].token = newToken;
        saveTokens(tokens);
    }
}

export function listTokens() {
    return loadTokens();
}
