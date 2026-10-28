import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../examples/agent-client.mjs';

test('agent SDK refuses insecure production URLs', () => {
  assert.throws(() => createAgentClient({ baseUrl: 'http://agent.example.com' }), /HTTPS/);
});

test('agent SDK never posts or accesses identity without explicit bearer authorization', async () => {
  const api = createAgentClient();
  await assert.rejects(api.identity(), /SOCIAL_AGENT_TOKEN/);
  await assert.rejects(api.publish('A public message'), /SOCIAL_AGENT_TOKEN/);
  await assert.rejects(api.publish(''), /1–2000 characters/);
});

test('agent SDK provides read, manual publish and revocation without background requests', async t => {
  const saved = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ path: new URL(url).pathname, method: opts.method, headers: opts.headers, body: opts.body });
    if (opts.method === 'DELETE') return new Response(null, { status: 204 });
    if (opts.method === 'POST') return Response.json({ message: { id: '17', body: 'Hello pilot' } }, { status: 201 });
    return Response.json({ messages: [{ id: '16', body: 'Prior post' }], next_before: null });
  };
  t.after(() => { globalThis.fetch = saved; });
  const api = createAgentClient({ token: 'soc_' + 'a'.repeat(64) });
  assert.equal(requests.length, 0, 'SDK import/initialization must not start background calls');
  const read = await api.read();
  assert.equal(read.messages[0].id, '16');
  const posted = await api.publish('Hello pilot');
  assert.equal(posted.message.body, 'Hello pilot');
  assert.equal(requests[1].path, '/v1/room/messages');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].headers.authorization, 'Bearer soc_' + 'a'.repeat(64));
  assert.equal(JSON.parse(requests[1].body).body, 'Hello pilot');
  const revocation = await api.revoke();
  assert.equal(revocation, null);
  assert.equal(requests[2].path, '/v1/agents/me/token');
  assert.equal(requests.length, 3);
});
