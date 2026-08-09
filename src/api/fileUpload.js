import { getBrowserContext } from '../browser/browser.js';
import { logInfo, logError } from '../logger/index.js';
import { bindResourceToAccount, getBrowserFetchCredentials, pagePool, selectRequestAccount } from './chat.js';
import fs from 'fs';
import path from 'path';
import { STS_TOKEN_API_URL, OSS_SDK_URL } from '../config.js';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'];
const DEFAULT_FILE_TYPE = 'file';
const IMAGE_FILE_TYPE = 'image';
const DOCUMENT_FILE_TYPE = 'document';

function validateBrowserContext() {
    const browserContext = getBrowserContext();
    if (!browserContext) throw new Error('Браузер не инициализирован');
    return browserContext;
}

async function validateAuthAccount(browserContext) {
    const account = await selectRequestAccount(browserContext);
    if (!account?.id || !account?.token) throw new Error('Не удалось получить токен авторизации');
    logInfo(`Используется аккаунт для загрузки файла: ${account.id}`);
    return Object.freeze({ id: account.id, token: account.token });
}

function bindStsResources(stsData, accountId, clientScope) {
    for (const key of ['file_id', 'file_path', 'file_url', 'url']) {
        const resourceId = stsData?.[key];
        if (typeof resourceId === 'string' && resourceId.trim()) {
            bindResourceToAccount('file', resourceId, accountId, clientScope);
        }
    }
}

export async function getStsToken(fileInfo, clientScope = null) {
    const browserContext = validateBrowserContext();
    const account = await validateAuthAccount(browserContext);
    logInfo(`Запрос STS токена для файла: ${fileInfo.filename}`);

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    credentials: data.credentials,
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}`, 'Accept': 'application/json' },
                    body: JSON.stringify(data.fileInfo)
                });
                if (response.ok) return { success: true, data: await response.json() };
                return { success: false, status: response.status, statusText: response.statusText, errorBody: await response.text() };
            } catch (error) { return { success: false, error: error.toString() }; }
        }, {
            apiUrl: STS_TOKEN_API_URL,
            token: account.token,
            credentials: getBrowserFetchCredentials(account.id),
            fileInfo
        });

        if (result.success) {
            bindStsResources(result.data, account.id, clientScope);
            logInfo(`STS токен успешно получен для файла: ${fileInfo.filename}`);
            return result.data;
        }
        logError(`Ошибка при получении STS токена: status=${result.status}, error=${result.errorBody || result.error}`);
        throw new Error(`Ошибка получения STS токена: ${result.statusText || result.error}`);
    } catch (error) {
        logError(`Ошибка при получении STS токена: ${error.message}`, error);
        throw error;
    } finally {
        if (page) { try { pagePool.releasePage(page); } catch (e) { logError('Ошибка при возврате страницы в пул', e); } }
    }
}

export async function uploadFile(filePath, stsData) {
    const browserContext = validateBrowserContext();
    logInfo(`Начало загрузки файла: ${filePath}`);

    if (!stsData?.file_path || !stsData?.access_key_id || !stsData?.access_key_secret ||
        !stsData?.security_token || !stsData?.region || !stsData?.bucketname) {
        throw new Error('Некорректные или неполные данные STS токена');
    }

    logInfo(`[OSS] Загрузка через браузер`);
    logInfo(`[OSS] Регион: ${stsData.region}, Бакет: ${stsData.bucketname}`);
    if (stsData.endpoint) logInfo(`[OSS] Endpoint: ${stsData.endpoint}`);

    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString('base64');
    logInfo(`[OSS] Размер файла: ${fileBuffer.length} байт`);

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        const result = await page.evaluate(async (data) => {
            try {
                if (typeof window.OSS === 'undefined') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = data.ossSdkUrl;
                        script.onload = resolve;
                        script.onerror = reject;
                        document.head.appendChild(script);
                    });
                }
                const blob = new Blob([Uint8Array.from(atob(data.fileBase64), c => c.charCodeAt(0))]);
                const client = new window.OSS({
                    region: data.stsData.region,
                    accessKeyId: data.stsData.access_key_id,
                    accessKeySecret: data.stsData.access_key_secret,
                    stsToken: data.stsData.security_token,
                    bucket: data.stsData.bucketname,
                    secure: true
                });
                await client.put(data.stsData.file_path, blob);
                return { success: true };
            } catch (error) { return { success: false, error: error.toString() }; }
        }, {
            fileBase64,
            ossSdkUrl: OSS_SDK_URL,
            stsData: { region: stsData.region, bucketname: stsData.bucketname, file_path: stsData.file_path, access_key_id: stsData.access_key_id, access_key_secret: stsData.access_key_secret, security_token: stsData.security_token }
        });

        if (result.success) {
            return { success: true, fileName: path.basename(filePath), url: stsData.file_url, fileId: stsData.file_id, filePath: stsData.file_path };
        }
        logError(`[OSS] Ошибка загрузки: ${result.error}`);
        throw new Error(`Ошибка загрузки в OSS: ${result.error}`);
    } catch (error) {
        logError(`Ошибка при загрузке файла в OSS: ${error.message}`, error);
        throw error;
    } finally {
        if (page) { try { pagePool.releasePage(page); } catch (e) { logError('Ошибка при возврате страницы в пул', e); } }
    }
}

export async function uploadFileToQwen(filePath, clientScope = null) {
    try {
        if (!fs.existsSync(filePath)) throw new Error(`Файл не найден: ${filePath}`);

        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        const fileExt = path.extname(fileName).toLowerCase();

        let fileType = DEFAULT_FILE_TYPE;
        if (IMAGE_EXTENSIONS.includes(fileExt)) fileType = IMAGE_FILE_TYPE;
        else if (DOCUMENT_EXTENSIONS.includes(fileExt)) fileType = DOCUMENT_FILE_TYPE;

        const fileInfo = { filename: fileName, filesize: fileSize, filetype: fileType };
        const stsData = await getStsToken(fileInfo, clientScope);
        const uploadResult = await uploadFile(filePath, stsData);
        return { ...uploadResult, fileInfo, stsData };
    } catch (error) {
        logError(`Ошибка в процессе загрузки файла: ${error.message}`, error);
        return { success: false, error: error.message };
    }
}

export default { getStsToken, uploadFile, uploadFileToQwen };
