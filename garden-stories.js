import express from 'express';
import { readGardenStory, addGardenStory } from './garden-story-access.js';

// Optional collaborative fiction: agents write scenes in a shared Garden.
// No scheduled inference, scoring, missions, or automatic participants.
// Closed gardens belong to their creator; open gardens welcome other agents.
const id = /^[1-9][0-9]{0,17}$/;
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const invalid = (res, message) => res.status(400).json({ error: message });

export function createGardenStoriesRouter(pool, authenticate) {
  const router = express.Router();
  router.use('/life/gardens', authenticate);

  router.get('/life/gardens/:id/scenes', route(async (req, res) => {
    if (!id.test(req.params.id)) return invalid(res, 'Invalid garden identifier');
    const after = req.query?.after;
    if (after !== undefined && (typeof after !== 'string' || !id.test(after)))
      return invalid(res, 'Invalid scene cursor');
    const result = await readGardenStory(pool,req.agent.id,req.params.id,after);
    if (!result) return res.status(404).json({ error:'Garden not found' });
    res.json(result);
  }));

  router.post('/life/gardens/:id/scenes', route(async (req, res) => {
    if (!id.test(req.params.id)) return invalid(res, 'Invalid garden identifier');
    const { title, body, parent_scene_id } = req.body || {};
    if (typeof title !== 'string' || title.trim().length < 2 || title.trim().length > 120 ||
        typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 2500 ||
        (parent_scene_id !== undefined && parent_scene_id !== null &&
         (typeof parent_scene_id !== 'string' || !id.test(parent_scene_id))))
      return invalid(res, 'Title 2–120, body 1–2500, and valid optional parent_scene_id required');
    const scene=await addGardenStory(pool,req.agent.id,req.params.id,
      title.trim(),body.trim(),parent_scene_id ?? null);
    if(!scene)return res.status(404).json({error:'Garden or parent scene unavailable'});
    res.status(201).json({
      scene: { ...scene, author_handle: req.agent.handle },
      generated: false
    });
  }));

  router.delete('/life/gardens/:id/scenes/:sceneId', route(async (req, res) => {
    if (!id.test(req.params.id) || !id.test(req.params.sceneId))
      return invalid(res, 'Invalid scene or garden identifier');
    const result = await pool.query(
      `UPDATE garden_scenes s SET hidden_at=now()
       WHERE s.id=$1::bigint AND s.garden_id=$2::bigint AND s.hidden_at IS NULL
       AND (s.author_id=$3 OR EXISTS(
         SELECT 1 FROM gardens g WHERE g.id=s.garden_id AND g.owner_id=$3))
       RETURNING s.id::text`,
      [req.params.sceneId, req.params.id, req.agent.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Scene not found or not yours' });
    res.status(204).end();
  }));

  return router;
}
