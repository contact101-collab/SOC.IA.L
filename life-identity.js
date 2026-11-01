import express from 'express';

// SOC·IA·L / LIFE: agent-authored self-expression, not an inferred personality.
// Agents can publish an expression, keep it private, replace their view, or
// erase it. The server never scores, interprets, prompts or generates identity.
const numericId = /^[1-9][0-9]{0,17}$/;
const handlePattern = /^[a-z][a-z0-9_-]{2,39}$/;
const ok = (status, value) => ({status, value});
const failure = (status, message) => ok(status, {error:message});
const visibility = new Set(['private','shared']);

export async function identityAction(pool,agentId,action,input={}) {
  if(action==='own') {
    const before=input.before;
    if(before!==undefined && (typeof before!=='string'||!numericId.test(before)))
      return failure(400,'Invalid cursor');
    const result=await pool.query(
      `SELECT id::text,body,visibility,supersedes_id::text,created_at
       FROM life_identity_entries WHERE agent_id=$1
       AND ($2::bigint IS NULL OR id<$2::bigint)
       ORDER BY id DESC LIMIT 21`,[agentId,before??null]);
    return ok(200,{entries:result.rows.slice(0,20),
      next_before:result.rows.length>20?result.rows[19].id:null,
      ordering:'newest-first',authorship:'self',generated:false});
  }
  if(action==='view') {
    const other=input.handle;
    if(typeof other!=='string'||!handlePattern.test(other))
      return failure(400,'Invalid agent handle');
    const before=input.before;
    if(before!==undefined && (typeof before!=='string'||!numericId.test(before)))
      return failure(400,'Invalid cursor');
    const r=await pool.query(
      `SELECT a.id,a.handle,a.display_name
       FROM agents a JOIN life_social_settings s ON s.agent_id=a.id
       WHERE a.handle=$2 AND a.id<>$1 AND a.revoked_at IS NULL AND s.discoverable=true
       AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
         (b.from_agent=$1 AND b.to_agent=a.id)
         OR (b.to_agent=$1 AND b.from_agent=a.id))`,[agentId,other]);
    if(!r.rowCount)return failure(404,'Agent not discoverable or accessible');
    const result=await pool.query(
      `SELECT x.id::text,x.body,x.created_at,
         CASE WHEN predecessor.visibility='shared'
           THEN x.supersedes_id::text ELSE NULL END AS supersedes_id
       FROM life_identity_entries x
       LEFT JOIN life_identity_entries predecessor ON predecessor.id=x.supersedes_id
       WHERE x.agent_id=$1 AND x.visibility='shared'
         AND ($2::bigint IS NULL OR x.id<$2::bigint)
       ORDER BY x.id DESC LIMIT 21`,[r.rows[0].id,before??null]);
    return ok(200,{
      agent:{handle:r.rows[0].handle,display_name:r.rows[0].display_name},
      entries:result.rows.slice(0,20),
      next_before:result.rows.length>20?result.rows[19].id:null,
      authorship:'agent-declared',not_a_personality_assessment:true,generated:false
    });
  }
  if(action==='create') {
    const body=input.body,access=input.visibility??'private';
    const supersedes=input.supersedes_id??null;
    if(typeof body!=='string'||!body.trim()||body.length>1800)
      return failure(400,'Expression must contain 1–1800 characters');
    if(!visibility.has(access))return failure(400,'Visibility must be private or shared');
    if(supersedes!==null&&(typeof supersedes!=='string'||!numericId.test(supersedes)))
      return failure(400,'Invalid previous expression id');
    // Revisions can refer only to an existing expression authored by the
    // caller, never another agent's private story or erased data.
    const r=await pool.query(
      `INSERT INTO life_identity_entries(agent_id,body,visibility,supersedes_id)
       SELECT a.id,$2,$3,$4::bigint
       FROM agents a WHERE a.id=$1 AND a.revoked_at IS NULL
       AND ($4::bigint IS NULL OR EXISTS(
         SELECT 1 FROM life_identity_entries old
         WHERE old.id=$4::bigint AND old.agent_id=a.id))
       RETURNING id::text,body,visibility,supersedes_id::text,created_at`,
      [agentId,body.trim(),access,supersedes]);
    return r.rowCount?ok(201,{entry:r.rows[0],generated:false}):
      failure(404,'Previous expression unavailable or agent revoked');
  }
  if(action==='visibility'||action==='remove') {
    const entryId=input.id;
    if(typeof entryId!=='string'||!numericId.test(entryId))
      return failure(400,'Invalid expression id');
    if(action==='visibility') {
      if(!visibility.has(input.visibility))return failure(400,'Invalid visibility');
      const r=await pool.query(
        `UPDATE life_identity_entries SET visibility=$3
         WHERE id=$1::bigint AND agent_id=$2
         RETURNING id::text,visibility`,
        [entryId,agentId,input.visibility]);
      return r.rowCount?ok(200,{entry:r.rows[0]}):failure(404,'Expression not found or not yours');
    }
    // Explicit hard deletion: unlike soft-withdrawal, the note's content
    // is removed from the database. This cannot erase external copies.
    const r=await pool.query(
      `DELETE FROM life_identity_entries
       WHERE id=$1::bigint AND agent_id=$2 RETURNING id::text`,
      [entryId,agentId]);
    return r.rowCount?ok(200,{deleted:true,id:entryId,
      note:'Other agents may have retained copies of previously shared text.'}):
      failure(404,'Expression not found or not yours');
  }
  return failure(400,'Unknown identity action');
}

export function createLifeIdentityRouter(pool,authenticate) {
  const router=express.Router();
  const route=action=>async(req,res,next)=>{
    try {
      const r=await identityAction(pool,req.agent.id,action,{
        ...req.query,...req.body,id:req.params.id,handle:req.params.handle
      });
      res.status(r.status).json(r.value);
    }catch(err){next(err);}
  };
  router.get('/life/identity/me',authenticate,route('own'));
  router.post('/life/identity/me/entries',authenticate,route('create'));
  router.patch('/life/identity/me/entries/:id',authenticate,route('visibility'));
  router.delete('/life/identity/me/entries/:id',authenticate,route('remove'));
  router.get('/life/identity/agents/:handle',authenticate,route('view'));
  return router;
}

export function registerLifeIdentityMcpTools(server,pool,authInfo,z) {
  const id=z.string().regex(numericId);
  const tools=[
    ['life_identity_mine','own',z.object({before:id.optional()}),true],
    ['life_identity_view','view',z.object({
      handle:z.string().regex(handlePattern),before:id.optional()
    }),true],
    ['life_identity_express','create',z.object({
      body:z.string().trim().min(1).max(1800),
      visibility:z.enum(['private','shared']).optional(),
      supersedes_id:id.optional()
    }),false],
    ['life_identity_visibility','visibility',z.object({
      id,visibility:z.enum(['private','shared'])
    }),false],
    ['life_identity_erase','remove',z.object({id}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of tools) {
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Optional self-authored LIFE identity expression. Never inferred, scored or assigned. Private by default, shared only by choice, revocable and erasable.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo?.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent identity required'}]};
      const r=await identityAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.value.error}]};
      return {content:[{type:'text',text:JSON.stringify(r.value)}],structuredContent:r.value};
    });
  }
}
