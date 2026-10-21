import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildQwenCompletionUrl,
  buildQwenRequestHeaders,
  createBrowserTokenCooldown,
  getBrowserFetchCredentials,
  getManagedAccountId,
  hasAlternativeAccount,
  isBrowserTokenCooldownActive,
  isQwenAntiBotBody,
  shouldReturnNodeStreamingResponse
} from '../src/api/chat.js';

test('buildQwenCompletionUrl appends chat_id query required by current Qwen API', () => {
  const url = buildQwenCompletionUrl('https://chat.qwen.ai/api/v2/chat/completions', 'chat-123');
  assert.equal(url, 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-123');
});

test('buildQwenCompletionUrl preserves existing query params', () => {
  const url = buildQwenCompletionUrl('https://chat.qwen.ai/api/v2/chat/completions?foo=bar', 'chat 123');
  assert.equal(url, 'https://chat.qwen.ai/api/v2/chat/completions?foo=bar&chat_id=chat+123');
});

test('buildQwenRequestHeaders includes current web headers expected by Qwen', () => {
  const headers = buildQwenRequestHeaders('token-value', () => 'request-id');
  assert.equal(headers.Authorization, 'Bearer token-value');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers.source, 'web');
  assert.equal(headers.Version, '0.2.63');
  assert.equal(headers['X-Request-Id'], 'request-id');
  assert.ok(headers.Timezone.includes('GMT'));
});

test('managed bearer requests omit the shared browser cookie jar', () => {
  assert.equal(getBrowserFetchCredentials('account-a'), 'omit');
  assert.equal(getBrowserFetchCredentials(getManagedAccountId('browser:managed-account')), 'omit');
  assert.equal(getBrowserFetchCredentials('browser:token-fingerprint'), 'same-origin');
  assert.equal(getBrowserFetchCredentials(null), 'omit');
});

test('browser token cooldown expires and does not follow a refreshed token', () => {
  const start = 1_000_000;
  const cooldown = createBrowserTokenCooldown('browser-token-a', 2, start);

  assert.equal(isBrowserTokenCooldownActive(cooldown, 'browser-token-a', start + 1), true);
  assert.equal(isBrowserTokenCooldownActive(cooldown, 'browser-token-a', start + 2 * 60 * 60 * 1000), false);
  assert.equal(isBrowserTokenCooldownActive(cooldown, 'browser-token-b', start + 1), false);
});

test('same request can discover an uncached browser fallback', async () => {
  let browserLookups = 0;
  const hasAlternative = await hasAlternativeAccount(
    { id: 'managed:account-a', token: 'managed-token-a' },
    {
      hasManagedAccount: () => false,
      resolveBrowserAccount: async () => {
        browserLookups += 1;
        return { id: 'browser:fingerprint-b', token: 'browser-token-b' };
      }
    }
  );

  assert.equal(hasAlternative, true);
  assert.equal(browserLookups, 1);
});

test('browser-side bearer fetches explicitly apply the selected cookie policy', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    fs.readFileSync(path.join(testDir, '../src/api/chat.js'), 'utf8'),
    fs.readFileSync(path.join(testDir, '../src/api/fileUpload.js'), 'utf8')
  ];

  for (const source of sources) {
    const bearerFetches = source.match(/fetch\(data\.(?:url|apiUrl), \{[\s\S]{0,700}?(?:Authorization|headers: data\.headers)[\s\S]{0,300}?\}\);/g) || [];
    assert.ok(bearerFetches.length > 0, 'expected at least one browser-side bearer fetch');
    for (const fetchBlock of bearerFetches) {
      assert.match(fetchBlock, /credentials: data\.credentials/);
    }
  }
});

test('Anthropic loopback bridge forwards the already validated proxy authorization', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const routesSource = fs.readFileSync(path.join(testDir, '../src/api/routes.js'), 'utf8');

  assert.match(routesSource, /inboundAuthorization\s*=\s*req\.get\('authorization'\)/);
  assert.match(routesSource, /loopbackHeaders\.Authorization\s*=\s*inboundAuthorization/);
  assert.match(routesSource, /http:\/\/\$\{loopbackHost\}:\$\{PORT\}\/api\/chat\/completions/);
  assert.doesNotMatch(routesSource, /req\.get\('host'\).*chat\/completions/);
});

test('isQwenAntiBotBody detects Qwen x5 captcha HTML challenge', () => {
  const body = '<script>sessionStorage.x5referer = window.location.href;window.location.replace("https://chat.qwen.ai//api/v2/chat/completions/_____tmd_____/punish?x5step=1");window._config_ = {"action":"captcha"};</script><!--rgv587_flag:sm-->';
  assert.equal(isQwenAntiBotBody(body), true);
  assert.equal(isQwenAntiBotBody('{"success":true}'), false);
});

test('isQwenAntiBotBody detects Qwen JSON captcha challenge', () => {
  const body = '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂"],"data":{"url":"https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?action=captcha&pureCaptcha="}}';
  assert.equal(isQwenAntiBotBody(body), true);
});

test('HTTP anti-bot responses fall back to browser fetch unless Node fetch is forced', () => {
  const challenge = { status: 403, errorBody: '<captcha>', antiBot: true };

  assert.equal(shouldReturnNodeStreamingResponse(challenge, false), false);
  assert.equal(shouldReturnNodeStreamingResponse(challenge, true), true);
  assert.equal(shouldReturnNodeStreamingResponse({ ...challenge, hasStreamedChunks: true }, false), true);
  assert.equal(shouldReturnNodeStreamingResponse({ status: 429, errorBody: 'rate limit' }, false), true);
});
