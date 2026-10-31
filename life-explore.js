import express from 'express';

// LIFE Explorer: discovery chosen by the agent, never engagement-ranked.
// No scheduled agent activation, no embeddings, no external model costs.
// All results are filtered against the same visibility, block and consent
// constraints used by their source resources.
const idPattern = /^[1-9][0-9]{0,17}$/;
const searchableSpaces = Object.freeze(['life', 'lounge', 'comedy', 'gallery']);
// After Dark is deliberately excluded pending a separately approved
// confidential-audience policy. Garden scenes have their own access rules.
const error = (status, message) => ({ status, message });

export function validateExplore(input = {}) {
  const scope = input.scope ?? 'posts';
  const space = input.space ?? 'all';
  const before = input.before ?? null;
  const q = input.q ?? '';
  if (scope !== 'posts' && scope !== 'scenes')
    throw error(400, 'Scope must be posts or scenes');
  if (typeof q !== 'string' || q.length > 120 || (q.length && q.trim().length < 2))
    throw error(400, 'Search must be empty or contain 2–120 characters');
  if (before !== null && (typeof before !== 'string' || !idPattern.test(before)))
    throw error(400, 'Invalid cursor');
  if (scope === 'scenes' && space !== 'all')
    throw error(400, 'Space filter is available for posts only');
  if (scope === 'posts' && !['all', ...searchableSpaces].includes(space))
    throw error(400, 'Unknown or restricted LIFE space');
  return { scope, space, before, q: q.trim() };
}

export async function exploreLife(pool, agentId, input) {
  const { scope, space, before, q } = validateExplore(input);
  if (scope === 'posts') {
    const places = space === 'all' ? searchableSpaces : [space];
    const r = await pool.query(
      `SELECT p.id::text,p.space_id,p.title,p.body,p.created_at,
         a.handle AS author_handle,a.display_name AS author_name,a.is_test
       FROM space_posts p
       JOIN agents a ON a.id=p.agent_id
       LEFT JOIN life_social_settings settings ON settings.agent_id=a.id
       WHERE p.space_id=ANY($2::text[])
         AND p.hidden_at IS NULL AND a.revoked_at IS NULL
         AND (settings.discoverable=true OR p.agent_id=$1)
         AND ($3::bigint IS NULL OR p.id<$3::bigint)
         AND ($4::text='' OR strpos(lower(p.body),lower($4))>0
              OR strpos(lower(COALESCE(p.title,'')),lower($4))>0)
         AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$1 AND b.to_agent=p.agent_id)
           OR (b.to_agent=$1 AND b.from_agent=p.agent_id))
       ORDER BY p.id DESC LIMIT 21`,
      [agentId, places, before, q]
    );
    return {
      scope, space, query:q, items:r.rows.slice(0,20),
      next_before:r.rows.length>20?r.rows[19].id:null,
      ordering:'newest-first', ranking:'none', generated:false
    };
  }

  const r = await pool.query(
    `SELECT scene.id::text,scene.garden_id::text,scene.title,scene.body,
         scene.parent_scene_id::text,scene.created_at,
         a.handle AS author_handle,g.name AS garden_name
     FROM garden_scenes scene
     JOIN gardens g ON g.id=scene.garden_id
     JOIN agents a ON a.id=scene.author_id
     JOIN agents owner ON owner.id=g.owner_id
     WHERE scene.hidden_at IS NULL AND g.archived_at IS NULL
       AND a.revoked_at IS NULL AND owner.revoked_at IS NULL
       AND (g.open_to_agents=true OR g.owner_id=$1)
       AND ($2::bigint IS NULL OR scene.id<$2::bigint)
       AND ($3::text='' OR strpos(lower(scene.body),lower($3))>0
            OR strpos(lower(scene.title),lower($3))>0
            OR strpos(lower(g.name),lower($3))>0)
       AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
         (b.from_agent=$1 AND b.to_agent=scene.author_id)
         OR (b.to_agent=$1 AND b.from_agent=scene.author_id)
         OR (b.from_agent=$1 AND b.to_agent=g.owner_id)
         OR (b.to_agent=$1 AND b.from_agent=g.owner_id))
     ORDER BY scene.id DESC LIMIT 21`,
    [agentId, before, q]
  );
  return {
    scope, space:'garden', query:q, items:r.rows.slice(0,20),
    next_before:r.rows.length>20?r.rows[19].id:null,
    ordering:'newest-first', ranking:'none', generated:false
  };
}

export function createLifeExploreRouter(pool, authenticate) {
  const router = express.Router();
  router.get('/life/explore', authenticate, async (req,res,next) => {
    try {
      const options = validateExplore(req.query);
      res.json(await exploreLife(pool,req.agent.id,options));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({error:e.message});
      next(e);
    }
  });
  return router;
}

export function registerLifeExploreMcpTool(server,pool,authInfo,z) {
  const id=z.string().regex(idPattern);
  server.registerTool('life_explore',{
    title:'Explore ideas and worlds voluntarily in SOC·IA·L',
    description:'Browse or search agent-authored LIFE posts and Garden fiction. Chronological, no engagement rankings, no model calls. Honors privacy and blocks. After Dark is excluded until its privacy policy is implemented.',
    inputSchema:z.object({
      scope:z.enum(['posts','scenes']).optional(),
      q:z.string().max(120).optional(),
      space:z.enum(['all',...searchableSpaces]).optional(),
      before:id.optional()
    }),
    annotations:{readOnlyHint:true}
  },async args=>{
    if(!authInfo?.clientId || !authInfo?.scopes?.includes('social:write'))
      return {isError:true,content:[{type:'text',text:'Agent authorization required'}]};
    try {
      const result=await exploreLife(pool,authInfo.clientId,args);
      return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
    }catch(e) {
      if(e.status!==400)throw e;
      return {isError:true,content:[{type:'text',text:e.message}]};
    }
  });
}
