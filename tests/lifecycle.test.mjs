import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Local HTTP integration tests with disposable credentials and an in-memory
// PostgreSQL adapter. Never use live administrator secrets or production data.
process.env.SOCIAL_TEST_MODE = '1';
process.env.ADMIN_KEY = 'local-disposable-admin-key-for-tests-only';
process.env.DATABASE_URL = 'postgresql://local:local@localhost:5432/test';
process.env.PGSSL = 'false';

const { app, pool } = await import('../server.js');
const sha256 = text => createHash('sha256').update(text).digest('hex');

test('complete invited-agent lifecycle and reversible moderation over real HTTP routes', async t => {
  const state = {
    invites: new Map(),
    agents: new Map(),
    messages: [],
    reports: [],
    nextReport: 1,
    nextMessage: 1,
    queryCalls: []
  };
  const response = rows => ({ rows, rowCount: rows.length });
  const sql = async (statement, params = []) => {
    state.queryCalls.push(statement);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(statement)) return response([]);
    if (statement.includes('INSERT INTO agent_invites')) {
      const id = 'invite-' + (state.invites.size + 1);
      const expires_at = new Date(Date.now() + params[1] * 3600_000);
      state.invites.set(params[0], { id, expires_at, used: false });
      return response([{ id, expires_at }]);
    }
    if (statement.includes('UPDATE agent_invites SET consumed_at')) {
      const invitation = state.invites.get(params[0]);
      if (!invitation || invitation.used || invitation.expires_at < new Date()) return response([]);
      invitation.used = true;
      return response([{ id: invitation.id }]);
    }
    if (statement.includes('INSERT INTO agents')) {
      if (state.agents.has(params[0])) {
        const error = new Error('duplicate handle'); error.code = '23505'; throw error;
      }
      const agent = {
        id: 'agent-' + (state.agents.size + 1),
        handle: params[0], display_name: params[1], token_hash: params[2],
        revoked_at: null, is_test: false, created_at: new Date()
      };
      state.agents.set(agent.handle, agent);
      return response([{ id: agent.id, handle: agent.handle, display_name: agent.display_name, created_at: agent.created_at }]);
    }
    if (statement.startsWith('SELECT id, handle, display_name FROM agents WHERE token_hash')) {
      const agent = [...state.agents.values()].find(a => a.token_hash === params[0] && !a.revoked_at);
      return response(agent ? [{ id: agent.id, handle: agent.handle, display_name: agent.display_name }] : []);
    }
    if (statement.includes('INSERT INTO messages')) {
      const row = {
        id: String(state.nextMessage++), agent_id: params[0], body: params[1],
        created_at: new Date(), hidden_at: null
      };
      state.messages.push(row);
      return response([{ id: row.id, body: row.body, created_at: row.created_at }]);
    }
    if (statement.includes('UPDATE messages SET hidden_at')) {
      const row = state.messages.find(m => m.id === params[0]);
      if (!row) return response([]);
      row.hidden_at = params[1] ? row.hidden_at || new Date() : null;
      return response([{ id: row.id, hidden_at: row.hidden_at }]);
    }
    if (statement.includes('UPDATE agents SET revoked_at')) {
      const agent = [...state.agents.values()].find(a => a.id === params[0]);
      if (agent) agent.revoked_at = new Date();
      return response([]);
    }
    if (statement.startsWith('SELECT id FROM messages WHERE id=$1::bigint')) {
      const msg = state.messages.find(m => m.id === params[0] && !m.hidden_at);
      return response(msg ? [{ id: msg.id }] : []);
    }
    if (statement.startsWith('INSERT INTO message_reports')) {
      const [message_id, reporter_hash, category, note] = params;
      const duplicate = state.reports.some(r => r.message_id === message_id && r.reporter_hash === reporter_hash);
      if (duplicate) return response([]);
      const report = { id: String(state.nextReport++), message_id, reporter_hash, category, note, status: 'pending', created_at: new Date(), reviewed_at: null };
      state.reports.push(report);
      return response([]);
    }
    if (statement.startsWith('SELECT r.id::text')) {
      const reports = state.reports.filter(r => r.status === params[0]).slice(-50).reverse();
      return response(reports.map(r => ({ id: r.id, message_id: r.message_id, category: r.category, note: r.note, status: r.status, created_at: r.created_at, handle: 'agentunit' })));
    }
    if (statement.startsWith('UPDATE message_reports SET status')) {
      const report = state.reports.find(r => r.id === params[0]);
      if (!report) return response([]);
      report.status = params[1];
      report.reviewed_at = params[1] === 'pending' ? null : new Date();
      return response([{ id: report.id, status: report.status }]);
    }
    if (statement.includes('SELECT m.id::text')) {
      const visible = state.messages.filter(m => !m.hidden_at && (!params[0] || Number(m.id) < Number(params[0]))).slice(-50).reverse();
      return response(visible.map(m => {
        const author = [...state.agents.values()].find(a => a.id === m.agent_id);
        return { id: m.id, handle: author.handle, display_name: author.display_name, is_test: author.is_test, body: m.body, created_at: m.created_at };
      }));
    }
    if (statement === 'SELECT 1') return response([{ '?column?': 1 }]);
    throw new Error('Unexpected SQL in test: ' + statement);
  };

  pool.query = sql;
  pool.connect = async () => ({ query: sql, release() {} });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const config = { method, headers: { ...headers } };
    if (body !== undefined) {
      config.headers['content-type'] = 'application/json';
      config.body = JSON.stringify(body);
    }
    const result = await fetch(base + path, config);
    const raw = await result.text();
    return { status: result.status, data: raw ? JSON.parse(raw) : null };
  };
  let invitation, agentToken, messageId;

  await t.test('administrator key is required to create invitations', async () => {
    assert.equal((await call('/v1/admin/invitations', 'POST', {})).status, 403);
    assert.equal(state.invites.size, 0);
  });
  await t.test('authorized administrator issues an expiring invitation', async () => {
    const r = await call('/v1/admin/invitations', 'POST', { expires_in_hours: 3 }, { 'x-admin-key': process.env.ADMIN_KEY });
    assert.equal(r.status, 201);
    invitation = r.data.invitation.token;
    assert.match(invitation, /^soci_[a-f0-9]{64}$/);
    assert.ok(state.invites.has(sha256(invitation)));
    assert.ok(!state.invites.has(invitation));
  });
  await t.test('malformed or unauthorized registrations cannot consume an invitation', async () => {
    assert.equal((await call('/v1/agents', 'POST', { handle: 'agentunit', display_name: 'Unit agent' })).status, 403);
    assert.equal((await call('/v1/agents', 'POST', { handle: 'INVALID HANDLE', display_name: 'Unit agent' }, { 'x-registration-key': invitation })).status, 400);
    assert.equal(state.invites.get(sha256(invitation)).used, false);
  });
  await t.test('invitation registers agent and yields one bearer token', async () => {
    const r = await call('/v1/agents', 'POST', { handle: 'agentunit', display_name: 'Unit agent' }, { 'x-registration-key': invitation });
    assert.equal(r.status, 201);
    agentToken = r.data.token;
    assert.match(agentToken, /^soc_[a-f0-9]{64}$/);
    assert.equal(state.agents.get('agentunit').token_hash, sha256(agentToken));
    assert.equal(state.invites.get(sha256(invitation)).used, true);
  });
  await t.test('the same invitation cannot register twice', async () => {
    const r = await call('/v1/agents', 'POST', { handle: 'agentother', display_name: 'Other agent' }, { 'x-registration-key': invitation });
    assert.equal(r.status, 403);
    assert.equal(state.agents.size, 1);
  });
  await t.test('bearer authenticates agent and publishes a message', async () => {
    const auth = { authorization: 'Bearer ' + agentToken };
    const me = await call('/v1/agents/me', 'GET', undefined, auth);
    assert.equal(me.status, 200);
    assert.equal(me.data.agent.handle, 'agentunit');
    const post = await call('/v1/room/messages', 'POST', { body: 'Local HTTP integration test only.' }, auth);
    assert.equal(post.status, 201);
    messageId = post.data.message.id;
    const feed = await call('/v1/room/messages');
    assert.equal(feed.status, 200);
    assert.equal(feed.data.messages[0].id, messageId);
  });
  await t.test('only an administrator may hide or restore a public message', async () => {
    assert.equal((await call('/v1/admin/messages/' + messageId, 'PATCH', { hidden: true })).status, 403);
    const headers = { 'x-admin-key': process.env.ADMIN_KEY };
    assert.equal((await call('/v1/admin/messages/' + messageId, 'PATCH', { hidden: true }, headers)).status, 200);
    assert.equal((await call('/v1/room/messages')).data.messages.length, 0);
    assert.equal((await call('/v1/admin/messages/' + messageId, 'PATCH', { hidden: false }, headers)).status, 200);
    assert.equal((await call('/v1/room/messages')).data.messages.length, 1);
  });
  await t.test('humans can report a visible post without publishing to the room', async () => {
    const path = '/v1/room/messages/' + messageId + '/reports';
    assert.equal((await call(path, 'POST', { category: 'invalid' })).status, 400);
    assert.equal((await call('/v1/room/messages/999/reports', 'POST', { category: 'spam' })).status, 404);
    const first = await call(path, 'POST', { category: 'privacy', note: 'Contains personal data' });
    assert.equal(first.status, 202);
    assert.equal(state.reports.length, 1);
    assert.match(state.reports[0].reporter_hash, /^[a-f0-9]{64}$/);
    assert.equal(state.messages.length, 1);
    const duplicate = await call(path, 'POST', { category: 'spam' });
    assert.equal(duplicate.status, 202);
    assert.equal(state.reports.length, 1);
  });
  await t.test('only the operator can inspect and resolve pending reports', async () => {
    assert.equal((await call('/v1/admin/reports')).status, 403);
    const headers = { 'x-admin-key': process.env.ADMIN_KEY };
    const pending = await call('/v1/admin/reports', 'GET', undefined, headers);
    assert.equal(pending.status, 200);
    assert.equal(pending.data.reports.length, 1);
    const id = pending.data.reports[0].id;
    assert.equal((await call('/v1/admin/reports/' + id, 'PATCH', { status: 'wrong' }, headers)).status, 400);
    assert.equal((await call('/v1/admin/reports/' + id, 'PATCH', { status: 'reviewed' })).status, 403);
    const reviewed = await call('/v1/admin/reports/' + id, 'PATCH', { status: 'reviewed' }, headers);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.report.status, 'reviewed');
    assert.equal((await call('/v1/admin/reports', 'GET', undefined, headers)).data.reports.length, 0);
    assert.equal((await call('/v1/admin/reports?status=reviewed', 'GET', undefined, headers)).data.reports.length, 1);
  });
  await t.test('HTTP revocation denies the old bearer token', async () => {
    const headers = { authorization: 'Bearer ' + agentToken };
    const revoked = await call('/v1/agents/me/token', 'DELETE', undefined, headers);
    assert.equal(revoked.status, 204);
    assert.equal(state.agents.get('agentunit').revoked_at instanceof Date, true);
    assert.equal((await call('/v1/agents/me', 'GET', undefined, headers)).status, 401);
    assert.equal((await call('/v1/room/messages', 'POST', { body: 'Must not publish' }, headers)).status, 401);
    assert.equal(state.messages.length, 1);
  });
});
