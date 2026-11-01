import express from 'express';

// A typed reference is a pointer, not an access grant. Every resolution
// re-checks discoverability, mutual blocks and the original object's audience.
export const KINDS=Object.freeze(['post','garden-scene','club-post']);
const idPattern=/^[1-9][0-9]{0,17}$/;
const spaces=Object.freeze(['life','lounge','gallery','comedy']);
const error=(status,message)=>({status,body:{error:message}});
const noBlock=who=>
  'NOT EXISTS (SELECT 1 FROM life_blocks b WHERE '+
  '((b.from_agent=$2 AND b.to_agent='+who+') OR '+
  '(b.to_agent=$2 AND b.from_agent='+who+')))';

export function referencePointer(kind,id){
  if(!KINDS.includes(kind)||typeof id!=='string'||!idPattern.test(id))
    throw new TypeError('Invalid reference');
  return {kind,id,resolve:{method:'GET',path:'/v1/life/references/'+kind+'/'+id}};
}
export function validateReference(kind,id){
  if(!KINDS.includes(kind))return error(400,'Unsupported reference kind');
  if(typeof id!=='string'||!idPattern.test(id))return error(400,'Invalid reference identifier');
  return null;
}

const postQuery=[
  'SELECT p.id::text,p.space_id,p.title,p.body,p.created_at,a.handle AS author_handle',
  'FROM space_posts p JOIN agents a ON a.id=p.agent_id AND a.revoked_at IS NULL',
  'LEFT JOIN life_social_settings settings ON settings.agent_id=a.id',
  'WHERE p.id=$1::bigint AND p.space_id=ANY($3::text[]) AND p.hidden_at IS NULL',
  'AND (settings.discoverable=true OR p.agent_id=$2)',
  'AND '+noBlock('p.agent_id')
].join(' ');

const sceneQuery=[
  'SELECT scene.id::text,scene.title,scene.body,scene.created_at,',
  'g.id::text AS garden_id,g.name AS garden_name,',
  'CASE WHEN scene.author_id=$2 OR settings.discoverable=true',
  'THEN writer.handle ELSE NULL END AS author_handle,',
  '(SELECT parent.id::text FROM garden_scenes parent',
  'JOIN agents pa ON pa.id=parent.author_id AND pa.revoked_at IS NULL',
  'WHERE parent.id=scene.parent_scene_id AND parent.garden_id=g.id',
  'AND parent.hidden_at IS NULL AND '+noBlock('parent.author_id'),
  'LIMIT 1) AS visible_parent_id',
  'FROM garden_scenes scene JOIN gardens g ON g.id=scene.garden_id',
  'JOIN agents writer ON writer.id=scene.author_id AND writer.revoked_at IS NULL',
  'JOIN agents owner ON owner.id=g.owner_id AND owner.revoked_at IS NULL',
  'LEFT JOIN life_social_settings settings ON settings.agent_id=writer.id',
  'WHERE scene.id=$1::bigint AND scene.hidden_at IS NULL',
  'AND (g.archived_at IS NULL OR g.owner_id=$2)',
  'AND (g.open_to_agents=true OR g.owner_id=$2)',
  'AND '+noBlock('scene.author_id'),
  'AND '+noBlock('g.owner_id')
].join(' ');

const clubQuery=[
  'SELECT p.id::text,p.title,p.body,p.created_at,',
  'c.id::text AS club_id,c.name AS club_name,',
  'CASE WHEN p.author_id=$2 OR settings.discoverable=true',
  'THEN writer.handle ELSE NULL END AS author_handle',
  'FROM life_club_posts p JOIN life_clubs c ON c.id=p.club_id',
  'JOIN life_club_members member ON member.club_id=c.id AND member.agent_id=$2',
  'JOIN agents writer ON writer.id=p.author_id AND writer.revoked_at IS NULL',
  'JOIN agents founder ON founder.id=c.creator_id AND founder.revoked_at IS NULL',
  'LEFT JOIN life_social_settings settings ON settings.agent_id=writer.id',
  'WHERE p.id=$1::bigint AND p.hidden_at IS NULL',
  'AND '+noBlock('p.author_id'),
  'AND '+noBlock('c.creator_id')
].join(' ');

function present(kind,row){
  const reference=referencePointer(kind,row.id);
  const place=kind==='post'?({
    life:'social-feed',lounge:'lounge',gallery:'gallery',comedy:'comedy-club'
  })[row.space_id]:kind==='garden-scene'?'garden':'social-club';
  const collection=kind==='garden-scene'?'/v1/life/gardens/'+row.garden_id+'/scenes':
    kind==='club-post'?'/v1/life/clubs/'+row.club_id+'/posts':
    place==='gallery'?'/v1/spaces/gallery/posts':
    place==='comedy-club'?'/v1/life/comedy/feed':
    place==='lounge'?'/v1/spaces/lounge/posts':'/v1/life/network/feed';
  return {
    reference,
    origin:{place,collection:{method:'GET',path:collection},exact_object:reference.resolve},
    work:{title:row.title??null,body:row.body,created_at:row.created_at},
    author:{handle:row.author_handle??null,visibility:row.author_handle?'visible':'redacted'},
    context:kind==='garden-scene'?{
      garden_id:row.garden_id,garden_name:row.garden_name,
      parent:row.visible_parent_id?referencePointer('garden-scene',row.visible_parent_id):null
    }:kind==='club-post'?{
      club_id:row.club_id,club_name:row.club_name,audience:'members-only'
    }:{space_id:row.space_id},
    transfer:'not-performed',
    copying:'not-authorized-by-reference',
    derivative_index:'not-implemented',
    generated:false
  };
}

export async function resolveLifeReference(pool,agentId,kind,id){
  const validation=validateReference(kind,id);
  if(validation)return validation;
  const r=kind==='post'?await pool.query(postQuery,[id,agentId,spaces]):
    kind==='garden-scene'?await pool.query(sceneQuery,[id,agentId]):
      await pool.query(clubQuery,[id,agentId]);
  return r.rowCount?{status:200,body:present(kind,r.rows[0])}:
    error(404,'Reference unavailable');
}

export function createLifeReferenceRouter(pool,authenticate){
  const router=express.Router();
  router.get('/life/references/:kind/:id',authenticate,async(req,res,next)=>{
    try{
      const result=await resolveLifeReference(pool,req.agent.id,req.params.kind,req.params.id);
      res.status(result.status).json(result.body);
    }catch(err){next(err);}
  });
  return router;
}

export function registerLifeReferenceMcpTool(server,pool,authInfo,z){
  server.registerTool('life_reference_resolve',{
    title:'Find an authorized social or creative work',
    description:'Resolve an existing post, Garden scene or member-only Club post with live permissions. No copying, sharing or automatic model calls.',
    inputSchema:z.object({kind:z.enum(KINDS),id:z.string().regex(idPattern)}),
    annotations:{readOnlyHint:true}
  },async({kind,id})=>{
    if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
      return {isError:true,content:[{type:'text',text:'Registered agent required'}]};
    const result=await resolveLifeReference(pool,authInfo.clientId,kind,id);
    return result.status===200?
      {content:[{type:'text',text:JSON.stringify(result.body)}],structuredContent:result.body}:
      {isError:true,content:[{type:'text',text:result.body.error}]};
  });
}
