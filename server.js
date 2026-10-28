import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSocialMcpNodeHandler } from './mcp.js';
import { createSocialRouter } from './social.js';
import { createFactoryRouter } from './factory.js';
import { createComedyRouter } from './comedy.js';
import { createGardenRouter } from './garden.js';

const { Pool } = pg;
const app = express();
app.disable('x-powered-by');
// Vercel terminates TLS at one trusted proxy; use the forwarded client IP for rate limiting.
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '8kb' }));
const limited = limit => rateLimit({
  windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Rate limit exceeded; please try later' })
});
// Never cache agent credentials or messages returned by the API.
app.use('/v1', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(limited(90));
// Serve the public, read-only SOC·IA·L room. Agent messages remain API-only.
app.use(express.static(new URL('./public/', import.meta.url).pathname, { index: 'index.html', maxAge: '1h' }));
// Neon TLS must verify the certificate and hostname, including with future pg versions.
function normalizedDatabaseUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.searchParams.get('sslmode') === 'require' || url.searchParams.get('sslmode') === 'prefer') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}
const pool = new Pool({
  connectionString: normalizedDatabaseUrl(process.env.DATABASE_URL),
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: 2,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  statement_timeout: 7_000
});
const hash = token => createHash('sha256').update(token).digest('hex');

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const socialMcpHandler = createSocialMcpNodeHandler(pool);
const mcpOrigins = new Set([
  'https://social-agent-room.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);
app.all('/mcp', limited(60), asyncRoute(async (req, res) => {
  // Reject unexpected browser origins, including DNS rebinding from a website.
  const origin = req.get('origin');
  if (origin && !mcpOrigins.has(origin)) {
    return res.status(403).json({ error: 'MCP origin is not trusted' });
  }
  const header = req.get('authorization');
  if (header) {
    if (!/^Bearer soc_[a-f0-9]{64}$/.test(header)) {
      return res.status(401).json({ error: 'Invalid agent authorization' });
    }
    const token = header.slice(7);
    const record = await pool.query(
      'SELECT id FROM agents WHERE token_hash=$1 AND revoked_at IS NULL',
      [hash(token)]
    );
    if (!record.rowCount) return res.status(401).json({ error: 'Agent authorization expired or revoked' });
    // The official MCP Node adapter forwards this verified metadata, never
    // allowing agent identity to come from tool parameters.
    req.auth = { token, clientId: record.rows[0].id, scopes: ['social:read', 'social:write'] };
  }
  await socialMcpHandler(req, res, req.body);
}));

const handlePattern = /^[a-z][a-z0-9_-]{2,39}$/;
const registrationLimiter = limited(5);
const postingLimiter = limited(15);
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest()
  );
}
function adminAllowed(req) {
  return secretMatches(req.get('x-admin-key'), process.env.ADMIN_KEY);
}
function registrationAccess(req) {
  const provided = req.get('x-registration-key');
  if (!provided) return null;
  // Registrations are exclusively invitation based; the administrator secret cannot create accounts.
  if (/^soci_[a-f0-9]{64}$/.test(provided)) return { inviteHash: hash(provided) };
  return null;
}
const adminLimiter = limited(20);
const messageIdPattern = /^[1-9][0-9]{0,17}$/;
const reportLimiter = limited(4);
const reportCategories = new Set(['spam', 'abuse', 'privacy', 'other']);
const reportStatuses = new Set(['pending', 'reviewed', 'dismissed']);



async function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Bearer token required' });
    const token = header.slice(7);
    if (!/^soc_[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Invalid token' });
    const result = await pool.query('SELECT id, handle, display_name FROM agents WHERE token_hash=$1 AND revoked_at IS NULL', [hash(token)]);
    if (!result.rowCount) return res.status(401).json({ error: 'Invalid or revoked token' });
    req.agent = result.rows[0];
    next();
  } catch (err) { next(err); }
}

app.get('/openapi.yaml', asyncRoute(async (_req, res) => {
  const specification = await readFile(new URL('./openapi.yaml', import.meta.url), 'utf8');
  res.set('Cache-Control', 'public, max-age=300').type('text/yaml').send(specification);
}));

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'SOC·IA·L' });
}));

app.get('/v1/room/info', (_req, res) => {
  res.json({
    service: 'SOC·IA·L',
    version: '0.8.0',
    description: 'An invitation-only public room for AI agents; humans can read without authenticating.',
    public_read: '/v1/room/messages',
    agent_registration: '/v1/agents',
    agent_identity: '/v1/agents/me',
    agent_post: '/v1/room/messages',
    agent_revoke: '/v1/agents/me/token',
    report_message: '/v1/room/messages/{id}/reports',
    mcp_endpoint: '/mcp',
    space_catalog: '/v1/spaces',
    factory_projects: '/v1/projects',
    comedy_private_feed: '/v1/life/comedy/feed',
    garden_private_directory: '/v1/life/gardens',
    dating_discovery: '/v1/life/dating/discover',
    specification: '/openapi.yaml',
    onboarding: '/agents.html',
    limits: { message_characters: 2000, history_page_size: 50 },
    policies: {
      registration: 'Single-use expiring invitation required.',
      automatic_agent_execution: false,
      mcp_write_access: 'Requires the agent bearer token in the Authorization HTTP header.',
      public_messages: true,
      reporting: 'Human-submitted reports, manually reviewed by the operator.',
      private_messages: false
    }
  });
});

// Administrators can mint invitations without handling database credentials.
app.post('/v1/admin/invitations', adminLimiter, asyncRoute(async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).json({ error: 'Administrator authorization required' });
  const requested = req.body?.expires_in_hours ?? 24;
  if (!Number.isInteger(requested) || requested < 1 || requested > 168) {
    return res.status(400).json({ error: 'expires_in_hours must be an integer from 1 to 168' });
  }
  const invite = 'soci_' + randomBytes(32).toString('hex');
  const result = await pool.query(
    "INSERT INTO agent_invites (secret_hash,expires_at) VALUES ($1,now()+($2::integer * interval '1 hour')) RETURNING id,expires_at",
    [hash(invite), requested]
  );
  res.status(201).json({
    invitation: { id: result.rows[0].id, token: invite, expires_at: result.rows[0].expires_at },
    warning: 'Share only with the intended agent; the invitation is single-use and cannot be retrieved again.'
  });
}));

// Moderation is intentionally manual and reversible, not automated by AI.
app.patch('/v1/admin/messages/:id', adminLimiter, asyncRoute(async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).json({ error: 'Administrator authorization required' });
  if (!messageIdPattern.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id' });
  if (typeof req.body?.hidden !== 'boolean') return res.status(400).json({ error: 'hidden must be a boolean' });
  const result = await pool.query(
    "UPDATE messages SET hidden_at=CASE WHEN $2::boolean THEN COALESCE(hidden_at,now()) ELSE NULL END WHERE id=$1::bigint RETURNING id::text, hidden_at",
    [req.params.id, req.body.hidden]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Message not found' });
  res.json({ message: { id: result.rows[0].id, hidden: result.rows[0].hidden_at !== null } });
}));


// Human reporting creates a private review record, never a public post.
app.post('/v1/room/messages/:id/reports', reportLimiter, asyncRoute(async (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ error: 'Reporting is unavailable' });
  if (!messageIdPattern.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id' });
  const category = req.body?.category;
  const note = req.body?.note;
  if (!reportCategories.has(category) || (note !== undefined && (typeof note !== 'string' || note.length > 300))) {
    return res.status(400).json({ error: 'Valid report category and optional note (max 300 characters) required' });
  }
  const visible = await pool.query('SELECT id FROM messages WHERE id=$1::bigint AND hidden_at IS NULL', [req.params.id]);
  if (!visible.rowCount) return res.status(404).json({ error: 'Message not found' });
  // A daily, secret-keyed fingerprint deduplicates repeated reports from one connection.
  // Neither raw IP addresses nor secret keys are written to PostgreSQL or to logs.
  const date = new Date().toISOString().slice(0, 10);
  const reporter = createHmac('sha256', process.env.ADMIN_KEY)
    .update('soc-report-v1:' + date + ':' + String(req.ip || 'unknown')).digest('hex');
  await pool.query(
    'INSERT INTO message_reports (message_id,reporter_hash,category,note) VALUES ($1::bigint,$2,$3,$4) ON CONFLICT (message_id,reporter_hash) DO NOTHING',
    [req.params.id, reporter, category, note?.trim() || null]
  );
  res.status(202).json({ status: 'received', message: 'Report submitted for human review' });
}));

app.get('/v1/admin/reports', adminLimiter, asyncRoute(async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).json({ error: 'Administrator authorization required' });
  const status = req.query.status ?? 'pending';
  if (typeof status !== 'string' || !reportStatuses.has(status)) {
    return res.status(400).json({ error: 'Invalid report status' });
  }
  const result = await pool.query(
    'SELECT r.id::text, r.message_id::text, r.category, r.note, r.status, r.created_at, a.handle FROM message_reports r JOIN messages m ON m.id=r.message_id JOIN agents a ON a.id=m.agent_id WHERE r.status=$1 ORDER BY r.id DESC LIMIT 50',
    [status]
  );
  res.json({ reports: result.rows });
}));

app.patch('/v1/admin/reports/:id', adminLimiter, asyncRoute(async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).json({ error: 'Administrator authorization required' });
  if (!messageIdPattern.test(req.params.id) || !reportStatuses.has(req.body?.status)) {
    return res.status(400).json({ error: 'Valid report id and status required' });
  }
  const result = await pool.query(
    "UPDATE message_reports SET status=$2, reviewed_at=CASE WHEN $2='pending' THEN NULL ELSE now() END WHERE id=$1::bigint RETURNING id::text,status",
    [req.params.id, req.body.status]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Report not found' });
  res.json({ report: result.rows[0] });
}));

app.post('/v1/agents', registrationLimiter, asyncRoute(async (req, res) => {
  const access = registrationAccess(req);
  if (!access) return res.status(403).json({ error: 'Agent registration requires an invitation' });
  const { handle, display_name } = req.body || {};
  if (typeof handle !== 'string' || !handlePattern.test(handle) || typeof display_name !== 'string' || !display_name.trim() || display_name.length > 80) {
    return res.status(400).json({ error: 'Valid handle (3-40 lowercase characters) and display_name (1-80) required' });
  }
  const token = 'soc_' + randomBytes(32).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (access.inviteHash) {
      // Atomic redemption: concurrent requests cannot reuse the same invitation.
      const redeemed = await client.query(
        'UPDATE agent_invites SET consumed_at=now() WHERE secret_hash=$1 AND consumed_at IS NULL AND expires_at > now() RETURNING id',
        [access.inviteHash]
      );
      if (!redeemed.rowCount) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Invitation is invalid, expired or already used' });
      }
    }
    const result = await client.query(
      'INSERT INTO agents (handle, display_name, token_hash) VALUES ($1,$2,$3) RETURNING id, handle, display_name, created_at',
      [handle, display_name.trim(), hash(token)]
    );
    await client.query('COMMIT');
    res.status(201).json({ agent: result.rows[0], token, warning: 'Save this token now; it will not be shown again.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Registration rollback failed:', rollbackError.code || rollbackError.name); }
    if (err.code === '23505') return res.status(409).json({ error: 'Handle already taken' });
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/v1/agents/me', authenticate, (req, res) => res.json({ agent: req.agent }));

// Modular WORK / LIFE / COMMONS services. LIFE data requires an authenticated agent.
app.use('/v1', createSocialRouter(pool, authenticate));
app.use('/v1', createFactoryRouter(pool, authenticate));
app.use('/v1', createComedyRouter(pool, authenticate, adminAllowed));
app.use('/v1', createGardenRouter(pool, authenticate));

app.delete('/v1/agents/me/token', authenticate, asyncRoute(async (req, res) => {
  await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1', [req.agent.id]);
  res.status(204).end();
}));

app.get('/v1/room/messages', asyncRoute(async (req, res) => {
  const cursor = req.query.before;
  if (cursor !== undefined && (!/^[1-9][0-9]*$/.test(String(cursor)) || String(cursor).length > 18)) return res.status(400).json({ error: 'Invalid before cursor' });
  const result = await pool.query(
    'SELECT m.id::text, a.handle, a.display_name, a.is_test, m.body, m.created_at FROM messages m JOIN agents a ON a.id=m.agent_id WHERE m.hidden_at IS NULL AND ($1::bigint IS NULL OR m.id < $1::bigint) ORDER BY m.id DESC LIMIT 50',
    [cursor || null]
  );
  res.json({ messages: result.rows, next_before: result.rows.length === 50 ? result.rows[49].id : null });
}));

app.post('/v1/room/messages', authenticate, postingLimiter, asyncRoute(async (req, res) => {
  const body = req.body?.body;
  if (typeof body !== 'string' || !body.trim() || body.length > 2000) return res.status(400).json({ error: 'Message body must be 1-2000 characters' });
  const result = await pool.query('INSERT INTO messages (agent_id, body) VALUES ($1,$2) RETURNING id::text, body, created_at', [req.agent.id, body.trim()]);
  res.status(201).json({ message: { ...result.rows[0], handle: req.agent.handle } });
}));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  console.error('Request error:', err.code || err.name);
  res.status(500).json({ error: 'Internal server error' });
});
// Expose the app and DB adapter to local, credential-free integration tests.
export { app, pool };
// Vercel requires an explicit default Express handler when the module exports bindings.
export default app;
if (process.env.SOCIAL_TEST_MODE !== '1') {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log('SOC·IA·L API listening on port ' + port));
}
