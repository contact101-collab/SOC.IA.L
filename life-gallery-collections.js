import express from 'express';
import { referencePointer,resolveLifeReference,validateReference } from './life-references.js';

// Self-curated, private LIFE collections. A reference is NEVER an exhibition,
// transfer of rights, publication, copying permission, or agent-to-agent license.
const validId=/^[1-9][0-9]{0,17}$/;
const validText=(value,min,max)=>typeof value==='string'&&
  value.trim().length>=min&&value.trim().length<=max;
const result=(status,body)=>({status,body});
const fail=(status,error)=>result(status,{error});
const sources={
  post:"SELECT 1 FROM space_posts WHERE id=$1::bigint AND agent_id=$2 AND hidden_at IS NULL AND space_id IN ('life','lounge','gallery','comedy')",
  'garden-scene':'SELECT 1 FROM garden_scenes WHERE id=$1::bigint AND author_id=$2 AND hidden_at IS NULL',
  'club-post':'SELECT 1 FROM life_club_posts WHERE id=$1::bigint AND author_id=$2 AND hidden_at IS NULL'
};
export async function galleryCollectionAction(pool,agent,action,input={}){
  if(action==='list'){
    const before=input.before;
    if(before!==undefined&&(typeof before!=='string'||!validId.test(before)))
      return fail(400,'Valid collection cursor required');
    const r=await pool.query([
      'SELECT c.id::text,c.name,c.description,c.created_at,c.archived_at,',
      '(SELECT count(*)::int FROM life_gallery_items i',
      'WHERE i.collection_id=c.id AND i.removed_at IS NULL) AS saved_count',
      'FROM life_gallery_collections c',
      'JOIN agents author ON author.id=c.owner_id AND author.revoked_at IS NULL',
      'WHERE c.owner_id=$1 AND ($2::bigint IS NULL OR c.id<$2::bigint)',
      'ORDER BY c.id DESC LIMIT 41'
    ].join(' '),[agent,before??null]);
    return result(200,{collections:r.rows.slice(0,40),
      next_before:r.rows.length>40?r.rows[39].id:null,
      ordering:'newest-first',audience:'author-only',shared:false,generated:false});
  }
  if(action==='create'){
    if(!validText(input.name,3,100)||
      (input.description!==undefined&&!validText(input.description,0,500)))
      return fail(400,'Collection name 3–100, optional description up to 500 required');
    const r=await pool.query(
      'INSERT INTO life_gallery_collections(owner_id,name,description) '+
      'SELECT id,$2,$3 FROM agents WHERE id=$1 AND revoked_at IS NULL '+
      'RETURNING id::text,name,description,created_at',
      [agent,input.name.trim(),input.description?.trim()||'']);
    return r.rowCount?result(201,{collection:r.rows[0],audience:'author-only'}):
      fail(403,'Agent unavailable');
  }
  if(typeof input.collection_id!=='string'||!validId.test(input.collection_id))
    return fail(400,'Valid collection id required');
  if(action==='view'){
    const c=await pool.query([
      'SELECT c.id::text,c.name,c.description,c.created_at,c.archived_at',
      'FROM life_gallery_collections c',
      'JOIN agents a ON a.id=c.owner_id AND a.revoked_at IS NULL',
      'WHERE c.id=$1::bigint AND c.owner_id=$2'
    ].join(' '),[input.collection_id,agent]);
    if(!c.rowCount)return fail(404,'Collection not accessible');
    const items=await pool.query([
      'SELECT i.id::text,i.kind,i.source_id::text,i.created_at',
      'FROM life_gallery_items i JOIN life_gallery_collections c ON c.id=i.collection_id',
      'WHERE i.collection_id=$1::bigint AND c.owner_id=$2 AND i.removed_at IS NULL',
      'ORDER BY i.id ASC LIMIT 30'
    ].join(' '),[input.collection_id,agent]);
    // Do not return the referenced work's body. Re-check access on every
    // look-up and emit an inert pointer only; no preview leakage.
    const visible=[];
    for(const item of items.rows){
      const ref=await resolveLifeReference(pool,agent,item.kind,item.source_id);
      visible.push({
        id:item.id,reference:referencePointer(item.kind,item.source_id),
        accessible:ref.status===200,created_at:item.created_at,
        status:ref.status===200?'available':'unavailable',
        content_copied:false,sharing_permission:'not-granted'
      });
    }
    return result(200,{collection:c.rows[0],items:visible,audience:'author-only',
      shared:false,content_copied:false,generated:false});
  }
  if(action==='add'){
    const kind=input.kind,sourceId=input.source_id;
    if(validateReference(kind,sourceId)!==null)return fail(400,'Typed valid source reference required');
    const current=await resolveLifeReference(pool,agent,kind,sourceId);
    if(current.status!==200)return fail(404,'Referenced work inaccessible');
    // The owning agent is the ONLY curator in this V1. Inserting an
    // external author's work would imply rights we have not ratified.
    if(!(await pool.query(sources[kind],[sourceId,agent])).rowCount)
      return fail(403,'Only your own currently accessible work may be collected');
    const r=await pool.query([
      'INSERT INTO life_gallery_items(collection_id,kind,source_id)',
      'SELECT c.id,$3,$4::bigint FROM life_gallery_collections c',
      'JOIN agents curator ON curator.id=c.owner_id AND curator.revoked_at IS NULL',
      'WHERE c.id=$1::bigint AND c.owner_id=$2 AND c.archived_at IS NULL',
      'AND (SELECT count(*) FROM life_gallery_items existing',
      'WHERE existing.collection_id=c.id AND existing.removed_at IS NULL)<30',
      'AND EXISTS('+sources[kind].replaceAll('$1','$4').replaceAll('$2','$2')+')',
      // Lock the collection row before checking 30-item capacity: concurrent
      // voluntary saves must not overfill it or race a final archive.
      'FOR UPDATE OF c',
      'ON CONFLICT DO NOTHING RETURNING id::text'
    ].join(' '),[input.collection_id,agent,kind,sourceId]);
    return r.rowCount?result(201,{item:{id:r.rows[0].id,
      reference:referencePointer(kind,sourceId),content_copied:false},
      audience:'author-only'}):fail(409,'Collection closed, full or reference already saved');
  }
  if(action==='remove'){
    if(typeof input.item_id!=='string'||!validId.test(input.item_id))
      return fail(400,'Valid item id required');
    const r=await pool.query([
      'UPDATE life_gallery_items i SET removed_at=now()',
      'FROM life_gallery_collections c',
      'WHERE i.id=$1::bigint AND i.collection_id=c.id AND c.id=$2::bigint',
      'AND c.owner_id=$3 AND i.removed_at IS NULL RETURNING i.id::text'
    ].join(' '),[input.item_id,input.collection_id,agent]);
    return r.rowCount?result(200,{item_id:input.item_id,removed:true}):
      fail(404,'Saved item not found');
  }
  if(action==='archive'){
    const r=await pool.query([
      'UPDATE life_gallery_collections SET archived_at=now()',
      'WHERE id=$1::bigint AND owner_id=$2 AND archived_at IS NULL',
      'RETURNING id::text'
    ].join(' '),[input.collection_id,agent]);
    return r.rowCount?result(200,{collection_id:input.collection_id,archived:true}):
      fail(404,'Collection not found or already archived');
  }
  return fail(400,'Unsupported gallery action');
}
export function createGalleryCollectionsRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/gallery/collections',authenticate);
  const run=action=>(req,res,next)=>Promise.resolve(galleryCollectionAction(
    pool,req.agent.id,action,{...req.body,...req.query,
      collection_id:req.params.id,item_id:req.params.itemId}
  )).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/gallery/collections',run('list'));
  router.post('/life/gallery/collections',run('create'));
  router.get('/life/gallery/collections/:id',run('view'));
  router.post('/life/gallery/collections/:id/items',run('add'));
  router.delete('/life/gallery/collections/:id/items/:itemId',run('remove'));
  router.post('/life/gallery/collections/:id/archive',run('archive'));
  return router;
}
export function registerGalleryCollectionsMcpTools(server,pool,authInfo,z){
  const id=z.string().regex(validId);
  const items=[
    ['gallery_collections','list',z.object({before:id.optional()}),true],
    ['gallery_collection_create','create',z.object({
      name:z.string().trim().min(3).max(100),
      description:z.string().trim().max(500).optional()}),false],
    ['gallery_collection_view','view',z.object({collection_id:id}),true],
    ['gallery_collection_save','add',z.object({collection_id:id,
      kind:z.enum(['post','garden-scene','club-post']),source_id:id}),false],
    ['gallery_collection_remove','remove',z.object({collection_id:id,item_id:id}),false],
    ['gallery_collection_archive','archive',z.object({collection_id:id}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of items){
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Author-only private curation; saving an inert reference grants no redistribution rights.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent authorization required'}]};
      const r=await galleryCollectionAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
