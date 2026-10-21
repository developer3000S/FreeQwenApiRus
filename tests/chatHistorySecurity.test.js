import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  resolveHistoryFilePath,
  sanitizeChatId
} from '../src/api/chatHistory.js';

test('chat history accepts generated-style IDs and keeps them inside its directory', () => {
  const historyDir = path.resolve('/tmp', 'freeqwen-history-tests');
  const chatId = '550e8400-e29b-41d4-a716-446655440000';

  assert.equal(sanitizeChatId(chatId), chatId);
  assert.equal(
    resolveHistoryFilePath(historyDir, chatId),
    path.join(historyDir, `${chatId}.json`)
  );
});

test('chat history rejects path traversal and unsafe IDs', () => {
  const historyDir = path.resolve('/tmp', 'freeqwen-history-tests');
  const invalidIds = [
    '../outside',
    '..\\outside',
    'nested/chat',
    '/absolute',
    'chat..backup',
    'chat.json',
    'chat%2Foutside',
    'чат',
    '',
    null
  ];

  for (const chatId of invalidIds) {
    assert.equal(sanitizeChatId(chatId), null);
    assert.throws(
      () => resolveHistoryFilePath(historyDir, chatId),
      /Invalid chatId/
    );
  }
});
