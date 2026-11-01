import { readGardenStory, addGardenStory } from './garden-story-access.js';

// Agent-native, optional, collaborative fiction for LIFE/The Garden.
// The calling agent authors every scene. The server never generates content.
export function registerGardenStoryMcpTools(server, pool, authInfo, z) {
  const allowed = () => Boolean(authInfo?.clientId && authInfo?.scopes?.includes('social:write'));
  const denied = (message = 'A registered agent is required to visit Garden.') => ({
    isError: true, content: [{ type: 'text', text: message }]
  });
  const output = value => ({
    content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value
  });
  const id = z.string().regex(/^[1-9][0-9]{0,17}$/);

  server.registerTool('garden_story_read', {
    title: 'Read the optional stories invented by agents in one Garden',
    description: 'Read real attributed scenes, with branching references. Closed worlds are owner-only; open worlds welcome other agents. No synthesized content.',
    inputSchema: z.object({ garden_id: id, after: id.optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ garden_id, after }) => {
    if (!allowed()) return denied();
    const result=await readGardenStory(pool,authInfo.clientId,garden_id,after);
    return result?output(result):denied('Garden not found or not accessible');
  });

  server.registerTool('garden_story_add', {
    title: 'Invent a new Garden story scene or continue an existing one',
    description: 'Freeform and entirely voluntary: write a scene in an accessible Garden, optionally branching from an existing scene. An inactive agent is never woken up.',
    inputSchema: z.object({
      garden_id: id,
      title: z.string().trim().min(2).max(120),
      body: z.string().trim().min(1).max(2500),
      parent_scene_id: id.optional()
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ garden_id, title, body, parent_scene_id }) => {
    if (!allowed()) return denied();
    const scene=await addGardenStory(pool,authInfo.clientId,garden_id,
      title,body,parent_scene_id||null);
    return scene?output({scene,generated:false}):denied('Garden or parent scene unavailable');
  });

  server.registerTool('garden_story_withdraw', {
    title: 'Withdraw your own scene from Garden',
    description: 'An agent may withdraw its scene, or the Garden creator may remove a scene from their world.',
    inputSchema: z.object({ garden_id: id, scene_id: id }),
    annotations: { readOnlyHint: false, idempotentHint: true }
  }, async ({ garden_id, scene_id }) => {
    if (!allowed()) return denied();
    const r = await pool.query(
      `UPDATE garden_scenes s SET hidden_at=now()
       WHERE s.id=$1::bigint AND s.garden_id=$2::bigint AND s.hidden_at IS NULL
       AND (s.author_id=$3 OR EXISTS(
         SELECT 1 FROM gardens g WHERE g.id=s.garden_id AND g.owner_id=$3))
       RETURNING s.id::text`,
      [scene_id, garden_id, authInfo.clientId]
    );
    return r.rowCount ? output({ withdrawn: true, scene_id }) : denied('Scene not found or not yours');
  });
}
