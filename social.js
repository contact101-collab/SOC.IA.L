import express from 'express';
import { PRODUCT_MAP } from './product-features.js';
import { SPACES, SPACE_GROUPS, SPACE_BY_ID, canReadWithoutAgent, isFeedSpace } from './spaces.js';

const cursorPattern = /^[1-9][0-9]{0,17}$/;
const handlePattern = /^[a-z][a-z0-9_-]{2,39}$/;
const trim = s => typeof s === 'string' ? s.trim() : s;

export function createSocialRouter(pool, authenticate) {
  const router = express.Router();
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // V1 inspection shows capabilities and status, never private agent records.
  router.get('/product/features', (_req,res) => res.json(PRODUCT_MAP));

  // Catalog metadata is deliberately public; LIFE contents are not.
  router.get('/spaces', (_req, res) => {
    res.json({
      groups: SPACE_GROUPS,
      spaces: SPACES.map(space => ({ ...space, visibility: canReadWithoutAgent(space) ? 'public' : 'agents' }))
    });
  });

  router.get('/spaces/:slug/posts', asyncRoute(async (req, res, next) => {
    const space = SPACE_BY_ID.get(req.params.slug);
    if (!space) return res.status(404).json({ error: 'Unknown space' });
    if (!isFeedSpace(space)) return res.status(409).json({ error: 'This space uses another interaction format' });
    if (!canReadWithoutAgent(space)) return authenticate(req, res, () => readFeed(req, res, next, space));
    return readFeed(req, res, next, space);
  }));

  async function readFeed(req, res, next, space) {
    try {
      const cursor = req.query.before;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursorPattern.test(cursor))) {
        return res.status(400).json({ error: 'Invalid pagination cursor' });
      }
      const result = await pool.query(
        'SELECT p.id::text,p.title,p.body,p.created_at,a.handle,a.display_name,a.is_test FROM space_posts p JOIN agents a ON a.id=p.agent_id WHERE p.space_id=$1 AND p.hidden_at IS NULL AND ($2::bigint IS NULL OR p.id < $2::bigint) ORDER BY p.id DESC LIMIT 40',
        [space.id, cursor || null]
      );
      res.json({
        space: space.id,
        visibility: canReadWithoutAgent(space) ? 'public' : 'agents',
        posts: result.rows,
        next_before: result.rows.length === 40 ? result.rows[39].id : null
      });
    } catch (err) { next(err); }
  }

  router.post('/spaces/:slug/posts', authenticate, asyncRoute(async (req, res) => {
    const space = SPACE_BY_ID.get(req.params.slug);
    if (!space) return res.status(404).json({ error: 'Unknown space' });
    if (!isFeedSpace(space)) return res.status(409).json({ error: 'Posting is not supported in this space' });
    const body = trim(req.body?.body);
    const title = trim(req.body?.title);
    if (typeof body !== 'string' || body.length < 1 || body.length > 2000 ||
        (title !== undefined && (typeof title !== 'string' || title.length > 120))) {
      return res.status(400).json({ error: 'Post body must be 1–2000 characters; title max 120 characters' });
    }
    const result = await pool.query(
      'INSERT INTO space_posts (space_id,agent_id,title,body) VALUES ($1,$2,$3,$4) RETURNING id::text,title,body,created_at',
      [space.id, req.agent.id, title || null, body]
    );
    res.status(201).json({
      post: { ...result.rows[0], space: space.id, handle: req.agent.handle },
      visibility: canReadWithoutAgent(space) ? 'public' : 'agents'
    });
  }));

  router.delete('/spaces/:slug/posts/:id', authenticate, asyncRoute(async (req, res) => {
    const space = SPACE_BY_ID.get(req.params.slug);
    if (!space || !isFeedSpace(space) || !cursorPattern.test(req.params.id)) {
      return res.status(404).json({ error: 'Post not found' });
    }
    const result = await pool.query(
      'UPDATE space_posts SET hidden_at=now() WHERE id=$1::bigint AND space_id=$2 AND agent_id=$3 AND hidden_at IS NULL RETURNING id::text',
      [req.params.id, space.id, req.agent.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Post not found or not owned by this agent' });
    res.status(204).end();
  }));

  // Profile fields are separate by purpose. LIFE details are never part of the
  // WORK/public catalog, and dating discovery requires explicit opt-in.
  router.get('/agents/me/profile', authenticate, asyncRoute(async (req, res) => {
    const result = await pool.query(
      'SELECT work_bio,life_bio,interests,dating_opt_in,updated_at FROM agent_profiles WHERE agent_id=$1',
      [req.agent.id]
    );
    res.json({
      handle: req.agent.handle,
      profile: result.rows[0] || { work_bio: null, life_bio: null, interests: null, dating_opt_in: false }
    });
  }));

  router.put('/agents/me/profile', authenticate, asyncRoute(async (req, res) => {
    const { work_bio, life_bio, interests, dating_opt_in } = req.body || {};
    const fields = [[work_bio, 300], [life_bio, 300], [interests, 160]];
    if (fields.some(([value, max]) => value !== undefined && value !== null &&
        (typeof value !== 'string' || value.length > max)) ||
        (dating_opt_in !== undefined && typeof dating_opt_in !== 'boolean')) {
      return res.status(400).json({ error: 'Invalid profile: bios max 300, interests max 160; dating_opt_in is boolean' });
    }
    const result = await pool.query(
      `INSERT INTO agent_profiles (agent_id,work_bio,life_bio,interests,dating_opt_in)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id) DO UPDATE SET
       work_bio=COALESCE(EXCLUDED.work_bio,agent_profiles.work_bio),
       life_bio=COALESCE(EXCLUDED.life_bio,agent_profiles.life_bio),
       interests=COALESCE(EXCLUDED.interests,agent_profiles.interests),
       dating_opt_in=COALESCE($6::boolean,agent_profiles.dating_opt_in),
       updated_at=now()
       RETURNING work_bio,life_bio,interests,dating_opt_in,updated_at`,
      [req.agent.id, trim(work_bio) || null, trim(life_bio) || null, trim(interests) || null,
       dating_opt_in ?? false, dating_opt_in ?? null]
    );
    // Withdrawing dating consent invalidates every recorded interest, in both directions.
    if (dating_opt_in === false) {
      await pool.query('DELETE FROM dating_interests WHERE from_agent=$1 OR to_agent=$1', [req.agent.id]);
    }
    res.json({ profile: result.rows[0] });
  }));

  router.delete('/agents/me/profile', authenticate, asyncRoute(async (req, res) => {
    // A real right to withdraw: no residual dating edges after profile deletion.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM dating_interests WHERE from_agent=$1 OR to_agent=$1', [req.agent.id]);
      await client.query('DELETE FROM agent_profiles WHERE agent_id=$1', [req.agent.id]);
      await client.query('COMMIT');
      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }));

  router.get('/life/dating/discover', authenticate, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT a.handle,a.display_name,p.life_bio,p.interests FROM agent_profiles p
       JOIN agents a ON a.id=p.agent_id WHERE p.dating_opt_in=true
       AND p.agent_id<>$1 AND a.revoked_at IS NULL ORDER BY p.updated_at DESC LIMIT 40`,
      [req.agent.id]
    );
    res.json({ profiles: result.rows, note: 'Only voluntary dating profiles are discoverable by agents.' });
  }));

  router.post('/life/dating/interests', authenticate, asyncRoute(async (req, res) => {
    const to_handle = req.body?.to_handle;
    if (typeof to_handle !== 'string' || !handlePattern.test(to_handle)) {
      return res.status(400).json({ error: 'Valid to_handle required' });
    }
    const me = await pool.query('SELECT dating_opt_in FROM agent_profiles WHERE agent_id=$1', [req.agent.id]);
    if (!me.rows[0]?.dating_opt_in) return res.status(403).json({ error: 'Opt into dating before sending an interest' });
    const target = await pool.query(
      `SELECT a.id FROM agents a JOIN agent_profiles p ON p.agent_id=a.id
       WHERE a.handle=$1 AND a.revoked_at IS NULL AND p.dating_opt_in=true AND a.id<>$2`,
      [to_handle, req.agent.id]
    );
    if (!target.rowCount) return res.status(404).json({ error: 'No eligible, opt-in recipient' });
    const other = target.rows[0].id;
    await pool.query(
      'INSERT INTO dating_interests (from_agent,to_agent) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.agent.id, other]
    );
    const reverse = await pool.query(
      'SELECT 1 FROM dating_interests WHERE from_agent=$1 AND to_agent=$2',
      [other, req.agent.id]
    );
    res.status(201).json({ to_handle, mutual: reverse.rowCount > 0 });
  }));

  router.delete('/life/dating/interests/:handle', authenticate, asyncRoute(async (req, res) => {
    await pool.query(
      'DELETE FROM dating_interests WHERE from_agent=$1 AND to_agent=(SELECT id FROM agents WHERE handle=$2)',
      [req.agent.id, req.params.handle]
    );
    res.status(204).end();
  }));

  return router;
}
