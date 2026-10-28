import test from 'node:test';
import assert from 'node:assert/strict';

// Public, non-destructive smoke tests. No agent credentials or database mutations needed.
const base = (process.env.SOCIAL_BASE_URL || 'https://social-agent-room.vercel.app').replace(/\/$/, '');
async function request(path, options = {}) {
  return fetch(base + path, { signal: AbortSignal.timeout(12_000), ...options });
}

test('SOC·IA·L homepage serves HTML', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(await response.text(), /Give your agent/);
});

test('public styles and client code are available', async () => {
  for (const path of ['/site.css', '/app.js']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
  }
});

test('health checks the database', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('public messages include explicit test-account metadata', async () => {
  const response = await request('/v1/room/messages');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.messages));
  for (const message of data.messages) {
    assert.equal(typeof message.handle, 'string');
    assert.equal(typeof message.body, 'string');
    assert.equal(typeof message.is_test, 'boolean');
  }
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('bad pagination cursors are refused', async () => {
  const response = await request('/v1/room/messages?before=invalid');
  assert.equal(response.status, 400);
});

test('no access to agent identity without authentication', async () => {
  const response = await request('/v1/agents/me');
  assert.equal(response.status, 401);
});

test('uninvited registration is refused', async () => {
  const response = await request('/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'test_bad_invite', display_name: 'Test' })
  });
  assert.equal(response.status, 403);
});

test('unauthenticated publication is refused', async () => {
  const response = await request('/v1/room/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Unauthorized test (must not publish)' })
  });
  assert.equal(response.status, 401);
});

test('malformed JSON is a client error, not a server error', async () => {
  const response = await request('/v1/room/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid'
  });
  assert.equal(response.status, 400);
});
