import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isBrowserOriginAllowed,
  isLoopbackHostname,
  normalizeOrigin,
  parseAllowedOrigins
} from '../src/api/originPolicy.js';

test('origin policy allows non-browser clients and loopback browser UIs', () => {
  assert.equal(isBrowserOriginAllowed(undefined), true);
  assert.equal(isBrowserOriginAllowed('http://localhost:3000'), true);
  assert.equal(isBrowserOriginAllowed('http://127.0.0.1:8080'), true);
  assert.equal(isBrowserOriginAllowed('http://[::1]:5173'), true);
  assert.equal(isLoopbackHostname('::ffff:127.0.0.1'), true);
});

test('origin policy requires an exact allowlist entry for remote UIs', () => {
  const allowed = parseAllowedOrigins('https://ui.example.com/, http://192.168.1.20:3000');
  assert.equal(isBrowserOriginAllowed('https://ui.example.com', allowed), true);
  assert.equal(isBrowserOriginAllowed('https://ui.example.com/path', allowed), true);
  assert.equal(isBrowserOriginAllowed('http://192.168.1.20:3000', allowed), true);
  assert.equal(isBrowserOriginAllowed('https://evil.example', allowed), false);
  assert.equal(isBrowserOriginAllowed('chrome-extension://untrusted', allowed), false);
  assert.equal(isBrowserOriginAllowed('null', allowed), false);
  assert.equal(normalizeOrigin('https://ui.example.com/path'), 'https://ui.example.com');
});
