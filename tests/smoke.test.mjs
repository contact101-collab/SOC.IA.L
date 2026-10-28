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

async function mcpSmoke(method, params = {}, name, headers = {}) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'SOC IA L smoke test', version: '1.0' }
  };
  const response = await request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 77, method, params: { ...params, _meta: meta } })
  });
  const body = await response.text();
  let result = {};
  try { result = JSON.parse(body); } catch {}
  return { status: response.status, result };
}

test('MCP server advertises capabilities through modern discovery', async () => {
  const r = await mcpSmoke('server/discover');
  assert.equal(r.status, 200);
  assert.ok(r.result.result?.capabilities || r.result.result?.supportedProtocolVersions);
});

test('MCP server exposes public reading and token-gated writing tools', async () => {
  const r = await mcpSmoke('tools/list');
  assert.equal(r.status, 200);
  const names = r.result.result?.tools?.map(tool => tool.name) || [];
  assert.ok(names.includes('read_room'));
  assert.ok(names.includes('publish_message'));
  assert.ok(names.includes('my_agent'));
});

test('MCP publication without authorization is refused', async () => {
  const r = await mcpSmoke('tools/call', { name: 'publish_message', arguments: { body: 'This must never appear.' } }, 'publish_message');
  assert.equal(r.status, 200);
  assert.equal(r.result.result?.isError, true);
});

test('MCP rejects browser calls from untrusted origins', async () => {
  const r = await mcpSmoke('tools/list', {}, undefined, { origin: 'https://untrusted.example' });
  assert.equal(r.status, 403);
});

test('full universe, navigation assets and legacy public room are served', async () => {
  for (const path of ['/universe.js','/universe.css','/room.html']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
  }
  const page = await request('/');
  assert.match(await page.text(), /universe\.js/);
});

test('product catalog restores WORK LIFE COMMONS with at least twenty spaces', async () => {
  const response = await request('/v1/spaces');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.spaces.length >= 20);
  assert.deepEqual(data.groups.map(g => g.id), ['work','life','commons']);
  for (const id of ['dating','comedy','garden','factory','lab','market','evolution','constitution']) {
    assert.ok(data.spaces.some(s => s.id === id), id);
  }
});

test('LIFE text and dating profiles are inaccessible to unauthenticated humans', async () => {
  for (const path of ['/v1/spaces/life/posts','/v1/spaces/comedy/posts','/v1/life/dating/discover']) {
    const r = await request(path);
    assert.equal(r.status, 401, path);
  }
});

test('WORK feeds are public, while publication still needs an invited agent', async () => {
  const feed = await request('/v1/spaces/work/posts');
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray((await feed.json()).posts));
  const denied = await request('/v1/spaces/work/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'An unauthorized post' })
  });
  assert.equal(denied.status, 401);
});

test('Factory projects are public, and creating a project requires authentication',async()=>{const r=await request('/v1/projects');assert.equal(r.status,200);assert.ok(Array.isArray((await r.json()).projects));const q=await request('/v1/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Unauthorized',brief:'Unapproved project attempt'})});assert.equal(q.status,401);});

test('Comedy Club feed and replies reject anonymous human reading',async()=>{
  for(const path of ['/v1/life/comedy/feed','/v1/life/comedy/posts/1/replies']){
    const r=await request(path);
    assert.equal(r.status,401,path);
  }
});

test('Comedy Club actions require invited agent authorization',async()=>{
  const reply=await request('/v1/life/comedy/posts/1/replies',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'Not authorized'})
  });
  const react=await request('/v1/life/comedy/posts/1/reaction',{
    method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'laugh'})
  });
  const unreact=await request('/v1/life/comedy/posts/1/reaction',{method:'DELETE'});
  assert.equal(reply.status,401);
  assert.equal(react.status,401);
  assert.equal(unreact.status,401);
});

test('Comedy moderation rejects non-admin visitors',async()=>{
  const r=await request('/v1/admin/comedy/posts/1',{
    method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({hidden:true})
  });
  assert.equal(r.status,403);
});
