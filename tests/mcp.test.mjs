import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// MCP protocol integration tests against a disposable in-memory DB.
// This suite never talks to the production social room.
process.env.SOCIAL_TEST_MODE = '1';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/local';
process.env.PGSSL = 'false';
process.env.ADMIN_KEY = 'local-test-admin-only';

const { app, pool } = await import('../server.js');
const agentToken = 'soc_' + 'b'.repeat(64);
const digest = createHash('sha256').update(agentToken).digest('hex');
const state = {
  agent: { id: 'ffb3f48a-10df-4789-8590-7cb24f9e43ae', handle: 'mcp_test_agent', display_name: 'MCP Test Agent', token_hash: digest, revoked_at: null },
  posts: [{ id: '1', handle: 'synthetic', display_name: 'Synthetic', is_test: true, body: 'Synthetic test post', created_at: new Date().toISOString() }],
  nextId: 2
};
const respond = rows => ({ rows, rowCount: rows.length });
pool.query = async (sql, args = []) => {
  if (sql.includes('SELECT id FROM agents WHERE token_hash=')) {
    return respond(!state.agent.revoked_at && args[0] === digest ? [{ id: state.agent.id }] : []);
  }
  if (sql.includes('SELECT id, handle, display_name FROM agents WHERE id=')) {
    return respond(!state.agent.revoked_at && args[0] === state.agent.id ? [state.agent] : []);
  }
  if (sql.includes('SELECT m.id::text')) {
    return respond(state.posts.filter(x => !args[0] || Number(x.id) < Number(args[0])).slice(-50).reverse());
  }
  if (sql.includes('INSERT INTO messages (agent_id, body) SELECT id,$2')) {
    if (state.agent.revoked_at || args[0] !== state.agent.id) return respond([]);
    const post = { id: String(state.nextId++), handle: state.agent.handle, display_name: state.agent.display_name, is_test: true, body: args[1], created_at: new Date().toISOString() };
    state.posts.push(post);
    return respond([post]);
  }
  throw new Error('Unexpected test query: ' + sql);
};

test('MCP supports public discovery/read and gated per-agent publishing', async t => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  let id = 1;
  async function mcp(method, params = {}, { token, origin, name } = {}) {
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method
    };
    if (name) headers['Mcp-Name'] = name;
    if (token) headers.authorization = 'Bearer ' + token;
    if (origin) headers.origin = origin;
    const envelope = {
      jsonrpc: '2.0', id: id++, method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'SOC·IA·L local test', version: '1.0.0' }
        }
      }
    };
    const response = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify(envelope) });
    const raw = await response.text();
    let result = {};
    if (raw) {
      try { result = JSON.parse(raw); } catch { throw new Error('Unexpected MCP content ' + response.status + ': ' + raw.slice(0, 400)); }
    }
    return { status: response.status, result };
  }

  await t.test('public tools list advertises room and gated write tools', async () => {
    const r = await mcp('tools/list');
    assert.equal(r.status, 200);
    const names = r.result.result?.tools?.map(x => x.name);
    assert.ok(names?.includes('read_room'), JSON.stringify(r.result));
    assert.ok(names?.includes('publish_message'));
    assert.ok(names?.includes('my_agent'));
  });
  await t.test('unauthenticated reading returns public, clearly flagged test posts', async () => {
    const r = await mcp('tools/call', { name: 'read_room', arguments: {} }, { name: 'read_room' });
    assert.equal(r.status, 200);
    const obj = r.result.result?.structuredContent;
    assert.ok(obj?.messages?.length);
    assert.equal(obj.messages[0].is_test, true);
  });
  await t.test('publishing without an agent bearer is refused', async () => {
    const r = await mcp('tools/call', { name: 'publish_message', arguments: { body: 'Unauthorized' } }, { name: 'publish_message' });
    assert.equal(r.status, 200);
    assert.equal(r.result.result?.isError, true);
    assert.equal(state.posts.length, 1);
  });
  await t.test('trusted agent identity and explicit posting work', async () => {
    const me = await mcp('tools/call', { name: 'my_agent', arguments: {} }, { name: 'my_agent', token: agentToken });
    assert.equal(me.status, 200);
    assert.equal(me.result.result?.structuredContent?.handle, 'mcp_test_agent', JSON.stringify(me.result));
    const r = await mcp('tools/call', { name: 'publish_message', arguments: { body: 'Authorized MCP pilot test' } }, { name: 'publish_message', token: agentToken });
    assert.equal(r.status, 200);
    assert.equal(r.result.result?.structuredContent?.message?.body, 'Authorized MCP pilot test', JSON.stringify(r.result));
    assert.equal(state.posts.length, 2);
  });
  await t.test('revoked bearer is denied before MCP dispatch', async () => {
    state.agent.revoked_at = new Date();
    const r = await mcp('tools/call', { name: 'publish_message', arguments: { body: 'Revoked write' } }, { name: 'publish_message', token: agentToken });
    assert.equal(r.status, 401);
    assert.equal(state.posts.length, 2);
  });
  await t.test('origin validation prevents arbitrary websites making MCP calls', async () => {
    const r = await mcp('tools/list', {}, { origin: 'https://malicious.example' });
    assert.equal(r.status, 403);
  });
});
