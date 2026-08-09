import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createAccountAffinityRegistry,
  resolveChatRequestContext
} from '../src/api/accountAffinity.js';
import {
  bindResourceToAccount,
  buildQwenRequestHeaders,
  getResourceAccountId,
  preflightFileRequest,
  resolveFileAccountId,
  sendMessage
} from '../src/api/chat.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a bound chat always reuses its owning account', async () => {
  const registry = createAccountAffinityRegistry();
  registry.bind('chat-a', 'account-a');
  let selectedFallback = false;

  const context = await resolveChatRequestContext({
    chatId: 'chat-a',
    parentId: 'parent-a',
    affinityRegistry: registry,
    getAccountToken: async accountId => ({ id: accountId, token: 'token-a' }),
    selectToken: async () => {
      selectedFallback = true;
      return { id: 'account-b', token: 'token-b' };
    }
  });

  assert.equal(selectedFallback, false);
  assert.deepEqual(context, {
    accountId: 'account-a',
    token: 'token-a',
    chatId: 'chat-a',
    parentId: 'parent-a',
    reusedChat: true,
    resetReason: null
  });
});

test('an unknown chat is not sent through an arbitrary account', async () => {
  const registry = createAccountAffinityRegistry();
  const context = await resolveChatRequestContext({
    chatId: 'chat-from-an-unknown-account',
    parentId: 'old-parent',
    affinityRegistry: registry,
    getAccountToken: async () => null,
    selectToken: async () => ({ id: 'account-b', token: 'token-b' })
  });

  assert.equal(context.accountId, 'account-b');
  assert.equal(context.chatId, null);
  assert.equal(context.parentId, null);
  assert.equal(context.reusedChat, false);
  assert.equal(context.resetReason, 'unknown_chat_affinity');
});

test('an unavailable owning account forces a fresh chat on the next account', async () => {
  const registry = createAccountAffinityRegistry();
  registry.bind('chat-a', 'account-a');

  const context = await resolveChatRequestContext({
    chatId: 'chat-a',
    parentId: 'parent-a',
    affinityRegistry: registry,
    getAccountToken: async () => null,
    selectToken: async () => ({ id: 'account-b', token: 'token-b' })
  });

  assert.equal(context.accountId, 'account-b');
  assert.equal(context.chatId, null);
  assert.equal(context.parentId, null);
  assert.equal(context.resetReason, 'bound_account_unavailable');
  assert.equal(registry.get('chat-a'), null);
});

test('parallel request contexts retain independent token snapshots', async () => {
  const registry = createAccountAffinityRegistry();
  registry.bind('chat-a', 'account-a');
  registry.bind('chat-b', 'account-b');
  const accountAGate = deferred();
  const accountBGate = deferred();

  const getAccountToken = async accountId => {
    if (accountId === 'account-a') {
      await accountAGate.promise;
      return { id: accountId, token: 'token-a' };
    }
    await accountBGate.promise;
    return { id: accountId, token: 'token-b' };
  };

  const requestA = resolveChatRequestContext({
    chatId: 'chat-a',
    affinityRegistry: registry,
    getAccountToken,
    selectToken: async () => null
  });
  const requestB = resolveChatRequestContext({
    chatId: 'chat-b',
    affinityRegistry: registry,
    getAccountToken,
    selectToken: async () => null
  });

  accountBGate.resolve();
  const contextB = await requestB;
  accountAGate.resolve();
  const contextA = await requestA;

  assert.equal(buildQwenRequestHeaders(contextA.token).Authorization, 'Bearer token-a');
  assert.equal(buildQwenRequestHeaders(contextB.token).Authorization, 'Bearer token-b');
  assert.equal(contextA.chatId, 'chat-a');
  assert.equal(contextB.chatId, 'chat-b');
  assert.equal(Object.isFrozen(contextA), true);
  assert.equal(Object.isFrozen(contextB), true);
});

test('a resource cannot be silently rebound to another account', () => {
  const registry = createAccountAffinityRegistry();
  assert.equal(registry.bind('chat-a', 'account-a'), true);
  assert.equal(registry.bind('chat-a', 'account-b'), false);
  assert.equal(registry.get('chat-a'), 'account-a');
});

test('uploaded file identifiers retain their owning account', () => {
  assert.equal(bindResourceToAccount('file', 'file-affinity-a', 'account-a'), true);
  const affinity = resolveFileAccountId([{ fileId: 'file-affinity-a' }]);

  assert.equal(affinity.accountId, 'account-a');
  assert.equal(affinity.hasFiles, true);
  assert.equal(affinity.hasKnownOwner, true);
  assert.equal(resolveFileAccountId([{ type: 'file', file: 'file-affinity-a' }]).accountId, 'account-a');
});

test('file affinity is isolated between proxy client scopes', () => {
  const sharedFileId = 'opaque-file-shared-between-clients';
  assert.equal(bindResourceToAccount('file', sharedFileId, 'account-a', 'client-a'), true);
  assert.equal(bindResourceToAccount('file', sharedFileId, 'account-b', 'client-b'), true);

  assert.equal(resolveFileAccountId([{ file_id: sharedFileId }], 'client-a').accountId, 'account-a');
  assert.equal(resolveFileAccountId([{ file_id: sharedFileId }], 'client-b').accountId, 'account-b');
  assert.equal(resolveFileAccountId([{ file_id: sharedFileId }], 'client-c').hasKnownOwner, false);
});

test('task affinity is isolated between proxy client scopes', () => {
  const sharedTaskId = 'opaque-task-shared-between-clients';
  bindResourceToAccount('task', sharedTaskId, 'account-a', 'client-a');
  bindResourceToAccount('task', sharedTaskId, 'account-b', 'client-b');

  assert.equal(getResourceAccountId('task', sharedTaskId, 'client-a'), 'account-a');
  assert.equal(getResourceAccountId('task', sharedTaskId, 'client-b'), 'account-b');
  assert.equal(getResourceAccountId('task', sharedTaskId, 'client-c'), null);
});

test('mixed-account and unknown files are not assigned to an arbitrary account', () => {
  bindResourceToAccount('file', 'file-affinity-b', 'account-b');
  bindResourceToAccount('file', 'file-affinity-c', 'account-c');

  assert.match(
    resolveFileAccountId([{ id: 'file-affinity-b' }, { id: 'file-affinity-c' }]).error,
    /разным Qwen-аккаунтам/
  );
  assert.deepEqual(resolveFileAccountId([{ id: 'file-affinity-unknown' }]), {
    accountId: null,
    hasFiles: true,
    hasKnownOwner: false,
    resourceIds: ['file-affinity-unknown']
  });
  assert.equal(
    resolveFileAccountId([{ id: 'file-affinity-b' }, { id: 'file-affinity-unknown' }]).hasKnownOwner,
    false
  );
  assert.equal(
    resolveFileAccountId([{ id: 'file-affinity-b', file_id: 'file-affinity-unknown' }]).hasKnownOwner,
    false
  );
});

test('a malformed files value fails closed before selecting an account', async () => {
  const result = await sendMessage(
    'read file',
    'qwen-test',
    null,
    null,
    { file_id: 'account-bound-file' }
  );

  assert.equal(result.invalidRequest, true);
  assert.equal(result.status, 400);
  assert.match(result.error, /files.*массивом/i);
});

test('an unsupported message shape is a client error before account selection', async () => {
  const result = await sendMessage({ bad: true });

  assert.equal(result.status, 400);
  assert.equal(result.invalidRequest, true);
  assert.match(result.error, /формат сообщения/i);
});

test('embedded and unknown account-bound files fail during synchronous preflight', () => {
  const result = preflightFileRequest([
    { type: 'input_file', input_file: { file_id: 'unknown-embedded-file' } }
  ], []);

  assert.equal(result.status, 409);
  assert.equal(result.reuploadRequired, true);
});
