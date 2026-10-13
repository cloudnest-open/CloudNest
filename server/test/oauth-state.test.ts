import test from 'node:test';
import assert from 'node:assert/strict';
import { startOAuthFlow, consumeOAuthState, makePkcePair, clearPendingOAuthForTests } from '../src/providers/oauth-state.js';

test('state is one-time use and bound to provider + session', () => {
  clearPendingOAuthForTests();
  const { state } = startOAuthFlow('dropbox', 'session-1');
  assert.ok(state.length > 20);
  // wrong provider
  assert.equal(consumeOAuthState(state, 'google_drive', 'session-1'), null);
  // wrong session
  assert.equal(consumeOAuthState(state, 'dropbox', 'session-2'), null);
});

test('valid consumption returns the provider and PKCE verifier', () => {
  clearPendingOAuthForTests();
  const pkce = makePkcePair();
  const { state } = startOAuthFlow('onedrive', 'session-9', pkce.verifier);
  const consumed = consumeOAuthState(state, 'onedrive', 'session-9');
  assert.equal(consumed?.provider, 'onedrive');
  assert.equal(consumed?.pkceVerifier, pkce.verifier);
  // reused state is rejected
  assert.equal(consumeOAuthState(state, 'onedrive', 'session-9'), null);
});

test('unknown/forged state is rejected', () => {
  clearPendingOAuthForTests();
  assert.equal(consumeOAuthState('forged-state-value', 'dropbox', 'session-1'), null);
  assert.equal(consumeOAuthState('', 'dropbox', 'session-1'), null);
});

test('multiple concurrent flows do not overwrite each other', () => {
  clearPendingOAuthForTests();
  const a = startOAuthFlow('dropbox', 'sA');
  const b = startOAuthFlow('google_drive', 'sB');
  const c = startOAuthFlow('dropbox', 'sA');
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.state, c.state);
  assert.equal(consumeOAuthState(a.state, 'dropbox', 'sA')?.provider, 'dropbox');
  assert.equal(consumeOAuthState(b.state, 'google_drive', 'sB')?.provider, 'google_drive');
  assert.equal(consumeOAuthState(c.state, 'dropbox', 'sA')?.provider, 'dropbox');
});

test('PKCE challenge is S256 of the verifier', async () => {
  const { verifier, challengeS256 } = makePkcePair();
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challengeS256);
});

test('pending-flow cap is enforced after cleanup', () => {
  clearPendingOAuthForTests();
  for (let i = 0; i < 200; i++) startOAuthFlow('dropbox', `s${i}`);
  assert.throws(() => startOAuthFlow('dropbox', 'overflow'));
  clearPendingOAuthForTests();
});
