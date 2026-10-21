import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getApiResultStatus, sendApiResultError } from '../src/api/apiErrors.js';

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    removedHeaders: [],
    headers: new Map(),
    removeHeader(name) {
      this.removedHeaders.push(name);
      this.headers.delete(name.toLowerCase());
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('API result errors preserve safe client and conflict statuses', () => {
  assert.equal(getApiResultStatus({ error: 'bad files', status: 400 }), 400);
  assert.equal(getApiResultStatus({ error: 'unknown owner', reuploadRequired: true }), 409);
  assert.equal(getApiResultStatus({ error: 'upstream failure' }), 500);
});

test('OpenAI error helper emits the chosen HTTP status and error type', () => {
  const res = fakeResponse();
  sendApiResultError(res, { error: 'files must be an array', status: 400 }, { openAI: true });

  assert.equal(res.statusCode, 400);
  assert.ok(res.removedHeaders.includes('Transfer-Encoding'));
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(res.body, {
    error: {
      message: 'files must be an array',
      type: 'invalid_request_error'
    }
  });
});
