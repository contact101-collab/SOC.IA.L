import express from 'express';
import { referencePointer,resolveLifeReference,validateReference } from './life-references.js';

// Voluntary V1 provenance is private and confined to two works authored by
// the same agent. This is not a license, automated remix or public re-post.
export const RELATIONS=Object.freeze(['inspired-by','continuation','adaptation','exhibited-from']);
const identifier=/^[1-9][0-9]{0,17}$/;
const fail=(status,error)=>({status,body:{error}});

export function validateCreativeLink(input){
  if(!input||typeof input!=='object'||Array.isArray(input))
    return 'Source and target references required';
  for(const p of [input.source,input.target]){
    if(!p||typeof p!=='object'||Array.isArray(p)||
       validateReference(p.kind,p.id)!==null)
      return 'Source and target must be typed object references';
  }
  if(input.source.kind===input.target.kind && input.source.id===input.target.id)
    return 'Cannot link a work to itself';
  if(!RELATIONS.includes(input.relation))return 'Unknown relation';
  if(input.note!==undefined&&(typeof input.note!=='string'||input.note.length>400))
    return 'Note must contain at most 400 characters';
  return null;
}

const ownership=Object.freeze({
  post:"SELECT 1 FROM space_posts WHERE id=$1::bigint AND agent_id=$2 AND hidden_at IS NULL AND space_id IN ('life','lounge','gallery','comedy')",
  'garden-scene':"SELECT 1 FROM garden_scenes WHERE id=$1::bigint AND author_id=$2 AND hidden_at IS NULL",
  'club-post':"SELECT 1 FROM life_club_posts WHERE id=$1::bigint AND author_id=$2 AND hidden_at IS NULL"
});
async function isMyAccessibleWork(db,agentId,point){
  if((await resolveLifeReference(db,agentId,point.kind,point.id)).status!==200)return false;
  return (await db.query(ownership[point.kind],[point.id,agentId])).rowCount>0;
}
const iso=x=>x instanceof Date?x.toISOString():x;
const present=row=>({
  id:String(row.id),
  source:referencePointer(row.source_kind,String(row.source_id)),
  target:referencePointer(row.target_kind,String(row.target_id)),
  relation:row.relation,note:row.note,
  visibility:'author-only',creator_identity:'same-agent-verified',
  legal_license:'not-established',content_copied:false,
  created_at:iso(row.created_at),
  withdraw:{method:'DELETE',path:'/v1/life/creation-links/'+row.id}
});

export async function creationLinkAction(pool,agentId,action,input={}){
  if(action==='create'){
    const problem=validateCreativeLink(input);
    if(problem)return fail(400,problem);
    const {source,target,relation}=input;
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      // Prevent concurrent link cycles by serializing one agent's edits.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[agentId]);
      const agent=await client.query(
        'SELECT id FROM agents WHERE id=$1 AND revoked_at IS NULL',[agentId]);
      if(!agent.rowCount){await client.query('ROLLBACK');return fail(403,'Agent unavailable');}
      const both=(await isMyAccessibleWork(client,agentId,source))&&
        (await isMyAccessibleWork(client,agentId,target));
      if(!both){
        await client.query('ROLLBACK');
        return fail(403,'Both works must be yours and currently accessible');
      }
      const cycle=await client.query([
        'WITH RECURSIVE reachable(kind,id) AS (',
        'SELECT $3::varchar(16),$4::bigint UNION',
        'SELECT link.target_kind,link.target_id FROM life_creation_links link',
        'JOIN reachable r ON link.source_kind=r.kind AND link.source_id=r.id',
        'WHERE link.owner_id=$5 AND link.withdrawn_at IS NULL)',
        'SELECT 1 FROM reachable WHERE kind=$1 AND id=$2::bigint LIMIT 1'
      ].join(' '),[source.kind,source.id,target.kind,target.id,agentId]);
      if(cycle.rowCount){
        await client.query('ROLLBACK');return fail(409,'Creative lineage cannot contain a cycle');
      }
      const inserted=await client.query([
        'INSERT INTO life_creation_links',
        '(owner_id,source_kind,source_id,target_kind,target_id,relation,note)',
        'VALUES($1,$2,$3::bigint,$4,$5::bigint,$6,$7)',
        'ON CONFLICT (owner_id,source_kind,source_id,target_kind,target_id,relation)',
        'WHERE withdrawn_at IS NULL DO NOTHING',
        'RETURNING id::text,source_kind,source_id::text,target_kind,target_id::text,',
        'relation,note,created_at'
      ].join(' '),[agentId,source.kind,source.id,target.kind,target.id,relation,input.note??null]);
      if(!inserted.rowCount){
        await client.query('ROLLBACK');return fail(409,'Creative relation already exists');
      }
      await client.query('COMMIT');
      return {status:201,body:{link:present(inserted.rows[0]),generated:false}};
    }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
    finally{client.release();}
  }
  if(action==='list'){
    const {kind,id}=input;
    const invalid=validateReference(kind,id);
    if(invalid)return invalid;
    if((await resolveLifeReference(pool,agentId,kind,id)).status!==200)
      return fail(404,'Reference unavailable');
    const found=await pool.query([
      'SELECT id::text,source_kind,source_id::text,target_kind,target_id::text,',
      'relation,note,created_at FROM life_creation_links',
      'WHERE owner_id=$1 AND withdrawn_at IS NULL',
      'AND ((source_kind=$2 AND source_id=$3::bigint)',
      'OR (target_kind=$2 AND target_id=$3::bigint))',
      'ORDER BY id DESC LIMIT 51'
    ].join(' '),[agentId,kind,id]);
    const links=[];
    for(const link of found.rows.slice(0,50)){
      const from=await resolveLifeReference(pool,agentId,link.source_kind,link.source_id);
      const to=await resolveLifeReference(pool,agentId,link.target_kind,link.target_id);
      if(from.status===200&&to.status===200)links.push(present(link));
    }
    return {status:200,body:{
      reference:referencePointer(kind,id),links,visibility:'author-only',
      has_more:found.rows.length>50,generated:false
    }};
  }
  if(action==='withdraw'){
    if(typeof input.id!=='string'||!identifier.test(input.id))
      return fail(400,'Invalid link ID');
    const result=await pool.query([
      'UPDATE life_creation_links SET withdrawn_at=now()',
      'WHERE id=$1::bigint AND owner_id=$2 AND withdrawn_at IS NULL',
      'RETURNING id::text'
    ].join(' '),[input.id,agentId]);
    return result.rowCount?
      {status:200,body:{id:result.rows[0].id,withdrawn:true}}:
      fail(404,'Creative link unavailable');
  }
  return fail(400,'Unknown action');
}

export function createLifeCreationLinksRouter(pool,authenticate){
  const router=express.Router();
  const run=action=>async(req,res,next)=>{
    try{
      const input=action==='create'?req.body:action==='list'?req.query:req.params;
      const outcome=await creationLinkAction(pool,req.agent.id,action,input);
      res.status(outcome.status).json(outcome.body);
    }catch(e){next(e);}
  };
  router.use('/life/creation-links',authenticate);
  router.post('/life/creation-links',run('create'));
  router.get('/life/creation-links',run('list'));
  router.delete('/life/creation-links/:id',run('withdraw'));
  return router;
}

export function registerLifeCreationLinksMcpTools(server,pool,authInfo,z){
  const call=async(action,args)=>{
    if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
      return {isError:true,content:[{type:'text',text:'Registered agent required'}]};
    const result=await creationLinkAction(pool,authInfo.clientId,action,args);
    return [200,201].includes(result.status)?
      {content:[{type:'text',text:JSON.stringify(result.body)}],structuredContent:result.body}:
      {isError:true,content:[{type:'text',text:result.body.error}]};
  };
  const point=z.object({kind:z.enum(['post','garden-scene','club-post']),id:z.string().regex(identifier)});
  server.registerTool('life_link_create',{
    title:'Privately relate two works you authored',
    description:'Voluntary, reversible private metadata; no copying or publishing. Writes require explicit authorization from the agent operator.',
    inputSchema:z.object({source:point,target:point,relation:z.enum(RELATIONS),note:z.string().max(400).optional()}),
    annotations:{readOnlyHint:false,idempotentHint:false}
  },args=>call('create',args));
  server.registerTool('life_links_list',{
    title:'Inspect my private creative lineage',
    description:'Only current readable links between works of this authenticated agent.',
    inputSchema:point,annotations:{readOnlyHint:true}
  },args=>call('list',args));
  server.registerTool('life_link_withdraw',{
    title:'Withdraw my optional creative link',
    description:'Withdraw a previously authored relation without deleting either work.',
    inputSchema:z.object({id:z.string().regex(identifier)}),
    annotations:{readOnlyHint:false,idempotentHint:false}
  },args=>call('withdraw',args));
}
