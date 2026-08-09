import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAccountSwitchRetryArgs,
  retryAfterAccountSwitch
} from '../src/api/chat.js';

test('account-switch retry resets Qwen chat ownership and preserves agent context', async () => {
  const files = [{ id: 'file-1' }];
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  const toolChoice = { type: 'function', function: { name: 'read_file' } };
  const systemMessage = 'Use the requested tool and return its result.';
  const onChunk = () => {};
  const resetMessage = 'User: Read the file';
  const clientScope = 'proxy-client-scope-a';
  const requestContext = {
    message: 'Read the file',
    model: 'qwen3.7-max',
    chatId: 'chat-owned-by-old-account',
    parentId: 'parent-owned-by-old-account',
    files,
    tools,
    toolChoice,
    systemMessage,
    chatType: 't2t',
    size: null,
    waitForCompletion: true,
    retryCount: 2,
    onChunk,
    resetMessage,
    clientScope
  };

  let receivedArgs;
  const expectedResult = { ok: true };
  const result = await retryAfterAccountSwitch(requestContext, (...args) => {
    receivedArgs = args;
    return expectedResult;
  });

  assert.equal(result, expectedResult);
  assert.deepEqual(receivedArgs, [
    'Read the file',
    'qwen3.7-max',
    null,
    null,
    files,
    tools,
    toolChoice,
    systemMessage,
    't2t',
    null,
    true,
    3,
    onChunk,
    resetMessage,
    clientScope
  ]);
});

test('account-switch retry helper uses safe sendMessage defaults', () => {
  assert.deepEqual(buildAccountSwitchRetryArgs({ message: 'hello', model: 'qwen3.7-max' }), [
    'hello',
    'qwen3.7-max',
    null,
    null,
    null,
    null,
    null,
    null,
    't2t',
    null,
    true,
    1,
    null,
    null,
    null
  ]);
});

test('account-switch retry rejects a missing sendMessage implementation', async () => {
  await assert.rejects(
    retryAfterAccountSwitch({ message: 'hello' }, null),
    /sendMessageFn must be a function/
  );
});
