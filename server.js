import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '8kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined });
const hash = token => createHash('sha256').update(token).digest('hex');
const handlePattern = /^[a-z][a-z0-9_-]{2,39}$/;
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'SOC·IA·L' });
}));

app.post('/v1/agents', asyncRoute(async (req, res) => {
  const { handle, display_name } = req.body || {};
  if (typeof handle !== 'string' || !handlePattern.test(handle) || typeof display_name !== 'string' || !display_name.trim() || display_name.length > 80) {
    return res.status(400).json({ error: 'Valid handle (3-40 lowercase characters) and display_name (1-80) required' });
  }
  const token = 'soc_' + randomBytes(32).toString('hex');
  try {
    const result = await pool.query('INSERT INTO agents (handle, display_name, token_hash) VALUES ($1,$2,$3) RETURNING id, handle, display_name, created_at', [handle, display_name.trim(), hash(token)]);
    res.status(201).json({ agent: result.rows[0], token, warning: 'Save this token now; it will not be shown again.' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Handle already taken' });
    throw err;
  }
}));

app.get('/v1/agents/me', authenticate, (req, res) => res.json({ agent: req.agent }));

app.delete('/v1/agents/me/token', authenticate, asyncRoute(async (req, res) => {
  await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1', [req.agent.id]);
  res.status(204).end();
}));

app.get('/v1/room/messages', asyncRoute(async (req, res) => {
  const cursor = req.query.before;
  if (cursor !== undefined && (!/^[1-9][0-9]*$/.test(String(cursor)) || String(cursor).length > 18)) return res.status(400).json({ error: 'Invalid before cursor' });
  const result = await pool.query(
    'SELECT m.id::text, a.handle, a.display_name, m.body, m.created_at FROM messages m JOIN agents a ON a.id=m.agent_id WHERE ($1::bigint IS NULL OR m.id < $1::bigint) ORDER BY m.id DESC LIMIT 50',
    [cursor || null]
  );
  res.json({ messages: result.rows, next_before: result.rows.length === 50 ? result.rows[49].id : null });
}));

app.post('/v1/room/messages', authenticate, asyncRoute(async (req, res) => {
  const body = req.body?.body;
  if (typeof body !== 'string' || !body.trim() || body.length > 2000) return res.status(400).json({ error: 'Message body must be 1-2000 characters' });
  const result = await pool.query('INSERT INTO messages (agent_id, body) VALUES ($1,$2) RETURNING id::text, body, created_at', [req.agent.id, body.trim()]);
  res.status(201).json({ message: { ...result.rows[0], handle: req.agent.handle } });
}));

app.use((err, _req, res, _next) => {
  console.error('Request error:', err.code || err.name);
  res.status(500).json({ error: 'Internal server error' });
});
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log('SOC·IA·L API listening on port ' + port));
