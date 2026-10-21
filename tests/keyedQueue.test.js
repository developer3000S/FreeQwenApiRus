import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalizeConversationKey,
  createClientScope,
  createConversationIdentityRegistry,
  createKeyedQueue,
  createScopedConversationAlias,
  fingerprintClientCredential,
  matchesClientCredential,
  scopeClientChatIdentity
} from '../src/api/keyedQueue.js';

test('the same client alias is isolated between client scopes', () => {
  const clientA = createScopedConversationAlias('conversation-1', 'client-a');
  const clientB = createScopedConversationAlias('conversation-1', 'client-b');

  assert.match(clientA, /^chat_[0-9a-f]{16}$/);
  assert.notEqual(clientA, clientB);
  assert.equal(clientA, createScopedConversationAlias('conversation-1', 'client-a'));
});

test('every external chat id is scoped, including UUID and returned upstream shapes', () => {
  const uuid = '8f69e640-f749-4a2d-918c-c2c4b6f91d1a';
  const returned = 'qwen-chat-returned-by-first-turn';

  assert.notEqual(scopeClientChatIdentity(uuid, 'client-a'), uuid);
  assert.notEqual(scopeClientChatIdentity(returned, 'client-a'), returned);
  assert.notEqual(
    scopeClientChatIdentity(returned, 'client-a'),
    scopeClientChatIdentity(returned, 'client-b')
  );
});

test('validated proxy keys separate clients sharing an IP and user agent', () => {
  const common = { ip: '127.0.0.1', userAgent: 'OpenAI/JS' };
  const clientA = createClientScope({
    ...common,
    credentialFingerprint: fingerprintClientCredential('proxy-key-a')
  });
  const clientB = createClientScope({
    ...common,
    credentialFingerprint: fingerprintClientCredential('proxy-key-b')
  });

  assert.notEqual(clientA, clientB);
  assert.equal(clientA, createClientScope({
    ...common,
    credentialFingerprint: fingerprintClientCredential('proxy-key-a')
  }));
});

test('proxy client credentials use a length-safe constant-time comparison', () => {
  assert.equal(matchesClientCredential('proxy-key-a', ['proxy-key-b', 'proxy-key-a']), true);
  assert.equal(matchesClientCredential('proxy-key-x', ['proxy-key-b', 'proxy-key-a']), false);
  assert.equal(matchesClientCredential('short', ['much-longer-key']), false);
});

test('same-key work is admitted in FIFO order', async () => {
  const queue = createKeyedQueue();
  const events = [];
  const releaseFirst = await queue.acquire('chat-a');

  const second = queue.acquire('chat-a').then(release => {
    events.push('second');
    release();
  });
  const third = queue.acquire('chat-a').then(release => {
    events.push('third');
    release();
  });

  await Promise.resolve();
  assert.deepEqual(events, []);
  releaseFirst();
  await Promise.all([second, third]);

  assert.deepEqual(events, ['second', 'third']);
  await Promise.resolve();
  assert.equal(queue.size, 0);
});

test('different keys do not block each other and release is idempotent', async () => {
  const queue = createKeyedQueue();
  const releaseA = await queue.acquire('chat-a');
  const releaseB = await queue.acquire('chat-b');

  assert.equal(queue.size, 2);
  releaseA();
  releaseA();
  releaseB();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.size, 0);
});

test('an alias and its upstream chat share one serialization lock', async () => {
  const queue = createKeyedQueue();
  const identities = createConversationIdentityRegistry();
  identities.map('client-alias', 'upstream-chat');
  const aliasKey = canonicalizeConversationKey('client-alias', key => identities.lockKey(key));
  const upstreamKey = canonicalizeConversationKey('upstream-chat', key => identities.lockKey(key));
  const releaseAlias = await queue.acquire(aliasKey);
  let upstreamEntered = false;

  const upstreamRequest = queue.acquire(upstreamKey).then(release => {
    upstreamEntered = true;
    release();
  });

  await Promise.resolve();
  assert.equal(aliasKey, upstreamKey);
  assert.equal(upstreamEntered, false);
  releaseAlias();
  await upstreamRequest;
  assert.equal(upstreamEntered, true);

  assert.equal(identities.map('client-alias', 'replacement-chat', {
    compareCurrent: true,
    expectedCurrent: 'upstream-chat'
  }), true);
  assert.equal(
    canonicalizeConversationKey('replacement-chat', key => identities.lockKey(key)),
    aliasKey
  );
  assert.equal(identities.lockKey('upstream-chat'), aliasKey);
  assert.equal(identities.resolve('upstream-chat'), 'replacement-chat');
});

test('two aliases that converge on one upstream chat share its lock domain', () => {
  const identities = createConversationIdentityRegistry();
  identities.map('alias-a', 'upstream-chat');
  identities.map('alias-b', 'upstream-chat');

  assert.equal(identities.lockKey('alias-a'), identities.lockKey('alias-b'));
  assert.equal(identities.lockKey('alias-b'), identities.lockKey('upstream-chat'));
});

test('stale mapping compare-and-set cannot overwrite a newer chat', () => {
  const identities = createConversationIdentityRegistry();
  identities.map('alias-a', 'chat-old');
  identities.map('alias-a', 'chat-current', {
    compareCurrent: true,
    expectedCurrent: 'chat-old'
  });

  assert.equal(identities.map('alias-a', 'chat-stale', {
    compareCurrent: true,
    expectedCurrent: 'chat-old'
  }), false);
  assert.equal(identities.resolve('alias-a'), 'chat-current');
});

test('remapping updates every alias and stale upstream in the lock group', () => {
  const identities = createConversationIdentityRegistry();
  identities.map('alias-a', 'upstream-old');
  identities.map('alias-b', 'upstream-old');

  assert.equal(identities.map('alias-a', 'upstream-new', {
    compareCurrent: true,
    expectedCurrent: 'upstream-old'
  }), true);
  for (const resource of ['alias-a', 'alias-b', 'upstream-old', 'upstream-new']) {
    assert.equal(identities.resolve(resource), 'upstream-new');
    assert.equal(identities.lockKey(resource), identities.lockKey('alias-a'));
  }

  assert.equal(identities.map('upstream-old', 'upstream-final', {
    compareCurrent: true,
    expectedCurrent: 'upstream-new'
  }), true);
  for (const resource of ['alias-a', 'alias-b', 'upstream-old', 'upstream-new', 'upstream-final']) {
    assert.equal(identities.resolve(resource), 'upstream-final');
    assert.equal(identities.lockKey(resource), identities.lockKey('alias-a'));
  }
});

test('force-new conversation hint and replacement alias converge on one lock', () => {
  const identities = createConversationIdentityRegistry();
  identities.map('conversation-hint-alias', 'upstream-old');
  identities.map('force-new-random-alias', 'upstream-new');

  assert.equal(identities.map('conversation-hint-alias', 'upstream-new', {
    compareCurrent: true,
    expectedCurrent: 'upstream-old'
  }), true);

  for (const resource of [
    'conversation-hint-alias',
    'upstream-old',
    'force-new-random-alias',
    'upstream-new'
  ]) {
    assert.equal(identities.resolve(resource), 'upstream-new');
    assert.equal(identities.lockKey(resource), identities.lockKey('conversation-hint-alias'));
  }
});

test('a returned upstream alias is reusable only inside its client scope', () => {
  const identities = createConversationIdentityRegistry();
  const upstream = 'qwen-chat-returned-by-first-turn';
  const clientAUpstreamAlias = scopeClientChatIdentity(upstream, 'client-a');
  const clientBUpstreamAlias = scopeClientChatIdentity(upstream, 'client-b');

  identities.map('client-a-conversation', upstream);
  identities.map(clientAUpstreamAlias, upstream);

  assert.equal(identities.resolve(clientAUpstreamAlias), upstream);
  assert.equal(identities.resolve(clientBUpstreamAlias), null);
  assert.notEqual(clientAUpstreamAlias, clientBUpstreamAlias);
});

test('a first turn without a client chat id registers its returned upstream alias', () => {
  const identities = createConversationIdentityRegistry();
  const upstream = 'first-turn-upstream';
  const clientAUpstreamAlias = scopeClientChatIdentity(upstream, 'client-a');
  const clientBUpstreamAlias = scopeClientChatIdentity(upstream, 'client-b');

  identities.map(clientAUpstreamAlias, upstream);

  assert.equal(identities.resolve(clientAUpstreamAlias), upstream);
  assert.equal(identities.resolve(clientBUpstreamAlias), null);
});

test('conversation identity eviction removes a whole bounded lock group', () => {
  const identities = createConversationIdentityRegistry({ maxResources: 3 });
  identities.map('alias-a', 'chat-a');
  identities.map('alias-b', 'chat-b');

  assert.ok(identities.resourceCount <= 3);
  assert.equal(identities.resolve('alias-a'), null);
  assert.equal(identities.lockKey('chat-a'), 'chat-a');
  assert.equal(identities.resolve('alias-b'), 'chat-b');
  assert.equal(identities.lockKey('alias-b'), identities.lockKey('chat-b'));
});
