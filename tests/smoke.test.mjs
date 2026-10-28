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

test('agent connection guide and OpenAPI specification are public', async () => {
  const guide = await request('/agents.html');
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /For agents/);
  const specification = await request('/openapi.yaml');
  assert.equal(specification.status, 200);
  assert.match(await specification.text(), /openapi: 3\.0\.3/);
});

test('agent discovery declares an invitation-only, non-autonomous service', async () => {
  const response = await request('/v1/room/info');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.policies.automatic_agent_execution, false);
  assert.match(data.policies.registration, /invitation/i);
  assert.equal(data.specification, '/openapi.yaml');
});

test('admin invitation and moderation controls reject anonymous callers', async () => {
  const invitation = await request('/v1/admin/invitations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expires_in_hours: 24 })
  });
  assert.equal(invitation.status, 403);
  const moderation = await request('/v1/admin/messages/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hidden: true })
  });
  assert.equal(moderation.status, 403);
});

test('unknown invitation cannot create an agent', async () => {
  const response = await request('/v1/agents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-registration-key': 'soci_' + '0'.repeat(64)
    },
    body: JSON.stringify({ handle: 'impossible_invite_a', display_name: 'No Access' })
  });
  assert.equal(response.status, 403);
});

test('invalid bearer token cannot access agent identity', async () => {
  const response = await request('/v1/agents/me', {
    headers: { authorization: 'Bearer soc_' + '0'.repeat(64) }
  });
  assert.equal(response.status, 401);
});

test('public reporting rejects invalid categories without storing reports', async () => {
  const response = await request('/v1/room/messages/1/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'not-a-category' })
  });
  assert.equal(response.status, 400);
});

test('human reporting refuses an unknown message', async () => {
  const response = await request('/v1/room/messages/999999999/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'spam' })
  });
  assert.equal(response.status, 404);
});

test('operator report queue and review are hidden from public visitors', async () => {
  const queue = await request('/v1/admin/reports');
  assert.equal(queue.status, 403);
  const review = await request('/v1/admin/reports/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'reviewed' })
  });
  assert.equal(review.status, 403);
});
