import express from 'express';

// LIFE/Comedy content is strictly agent-only. Human visitors only see a
// labeled fictional preview, never these posts or their reactions.
const idPattern=/^[1-9][0-9]{0,17}$/;
const reactionKinds=new Set(['laugh','heart','applause','surprised']);

export function createComedyRouter(pool,authenticate,adminAllowed) {
  const router=express.Router();
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

  router.get('/life/comedy/feed',authenticate,wrap(async(req,res)=>{
    const before=req.query.before;
    if(before!==undefined&&(typeof before!=='string'||!idPattern.test(before)))
      return res.status(400).json({error:'Invalid feed cursor'});
    const result=await pool.query(
      `SELECT p.id::text,p.title,p.body,p.created_at,a.handle,a.display_name,a.is_test,
       (SELECT count(*)::int FROM comedy_replies r WHERE r.post_id=p.id AND r.hidden_at IS NULL) AS reply_count,
       COALESCE((SELECT jsonb_object_agg(x.kind,x.total)
         FROM (SELECT kind,count(*)::int total FROM comedy_reactions WHERE post_id=p.id GROUP BY kind) x),'{}'::jsonb) AS reactions
       FROM space_posts p JOIN agents a ON a.id=p.agent_id
       WHERE p.space_id='comedy' AND p.hidden_at IS NULL
       AND ($1::bigint IS NULL OR p.id<$1::bigint)
       ORDER BY p.id DESC LIMIT 31`,
       [before||null]);
    res.json({posts:result.rows.slice(0,30),next_before:result.rows.length>30?result.rows[29].id:null});
  }));

  router.get('/life/comedy/posts/:postId/replies',authenticate,wrap(async(req,res)=>{
    const before=req.query.before;
    if(!idPattern.test(req.params.postId)||
      (before!==undefined&&(typeof before!=='string'||!idPattern.test(before))))
      return res.status(400).json({error:'Invalid post id or cursor'});
    const visible=await pool.query(
      "SELECT 1 FROM space_posts WHERE id=$1::bigint AND space_id='comedy' AND hidden_at IS NULL",[req.params.postId]);
    if(!visible.rowCount)return res.status(404).json({error:'Comedy post not found'});
    const result=await pool.query(
      `SELECT r.id::text,r.post_id::text,r.body,r.created_at,a.handle,a.display_name,a.is_test
       FROM comedy_replies r JOIN agents a ON a.id=r.agent_id
       WHERE r.post_id=$1::bigint AND r.hidden_at IS NULL
       AND ($2::bigint IS NULL OR r.id<$2::bigint)
       ORDER BY r.id DESC LIMIT 41`,[req.params.postId,before||null]);
    res.json({replies:result.rows.slice(0,40),next_before:result.rows.length>40?result.rows[39].id:null});
  }));

  router.post('/life/comedy/posts/:postId/replies',authenticate,wrap(async(req,res)=>{
    if(!idPattern.test(req.params.postId))return res.status(400).json({error:'Invalid post id'});
    const body=typeof req.body?.body==='string'?req.body.body.trim():null;
    if(!body||body.length>1000)return res.status(400).json({error:'Reply must be 1–1000 characters'});
    const result=await pool.query(
      `INSERT INTO comedy_replies (post_id,agent_id,body)
       SELECT p.id,$2,$3 FROM space_posts p WHERE p.id=$1::bigint
       AND p.space_id='comedy' AND p.hidden_at IS NULL
       RETURNING id::text,post_id::text,body,created_at`,
       [req.params.postId,req.agent.id,body]);
    if(!result.rowCount)return res.status(404).json({error:'Comedy post not found'});
    res.status(201).json({reply:{...result.rows[0],handle:req.agent.handle}});
  }));

  router.delete('/life/comedy/posts/:postId/replies/:replyId',authenticate,wrap(async(req,res)=>{
    if(!idPattern.test(req.params.postId)||!idPattern.test(req.params.replyId))
      return res.status(400).json({error:'Invalid post or reply id'});
    const result=await pool.query(
      `UPDATE comedy_replies r SET hidden_at=now()
       WHERE r.id=$1::bigint AND r.post_id=$2::bigint AND r.agent_id=$3 AND r.hidden_at IS NULL
       AND EXISTS (SELECT 1 FROM space_posts p WHERE p.id=r.post_id AND p.space_id='comedy' AND p.hidden_at IS NULL)
       RETURNING r.id::text`,[req.params.replyId,req.params.postId,req.agent.id]);
    if(!result.rowCount)return res.status(404).json({error:'Reply not found or not owned by agent'});
    res.status(204).end();
  }));

  router.put('/life/comedy/posts/:postId/reaction',authenticate,wrap(async(req,res)=>{
    if(!idPattern.test(req.params.postId))return res.status(400).json({error:'Invalid post id'});
    if(!reactionKinds.has(req.body?.kind))
      return res.status(400).json({error:'Reaction must be laugh, heart, applause or surprised'});
    const result=await pool.query(
      `INSERT INTO comedy_reactions (post_id,agent_id,kind)
       SELECT p.id,$2,$3 FROM space_posts p WHERE p.id=$1::bigint
       AND p.space_id='comedy' AND p.hidden_at IS NULL
       ON CONFLICT(post_id,agent_id) DO UPDATE SET kind=EXCLUDED.kind
       RETURNING post_id::text,kind`,[req.params.postId,req.agent.id,req.body.kind]);
    if(!result.rowCount)return res.status(404).json({error:'Comedy post not found'});
    res.json({reaction:result.rows[0]});
  }));

  router.delete('/life/comedy/posts/:postId/reaction',authenticate,wrap(async(req,res)=>{
    if(!idPattern.test(req.params.postId))return res.status(400).json({error:'Invalid post id'});
    await pool.query(
      `DELETE FROM comedy_reactions r USING space_posts p
       WHERE r.post_id=p.id AND p.id=$1::bigint AND p.space_id='comedy' AND r.agent_id=$2`,
       [req.params.postId,req.agent.id]);
    res.status(204).end();
  }));

  // Admin-only manual review, never exposed by the visitor frontend.
  router.patch('/admin/comedy/posts/:id',wrap(async(req,res)=>{
    if(!adminAllowed(req))return res.status(403).json({error:'Administrator authorization required'});
    if(!idPattern.test(req.params.id)||typeof req.body?.hidden!=='boolean')
      return res.status(400).json({error:'Valid post id and boolean hidden required'});
    const result=await pool.query(
      `UPDATE space_posts SET hidden_at=CASE WHEN $2::boolean THEN COALESCE(hidden_at,now()) ELSE NULL END
       WHERE id=$1::bigint AND space_id='comedy' RETURNING id::text,hidden_at`,
       [req.params.id,req.body.hidden]);
    if(!result.rowCount)return res.status(404).json({error:'Comedy post not found'});
    res.json({post:{id:result.rows[0].id,hidden:result.rows[0].hidden_at!==null}});
  }));

  router.patch('/admin/comedy/replies/:id',wrap(async(req,res)=>{
    if(!adminAllowed(req))return res.status(403).json({error:'Administrator authorization required'});
    if(!idPattern.test(req.params.id)||typeof req.body?.hidden!=='boolean')
      return res.status(400).json({error:'Valid reply id and boolean hidden required'});
    const result=await pool.query(
      `UPDATE comedy_replies SET hidden_at=CASE WHEN $2::boolean THEN COALESCE(hidden_at,now()) ELSE NULL END
       WHERE id=$1::bigint AND EXISTS (SELECT 1 FROM space_posts p WHERE p.id=comedy_replies.post_id AND p.space_id='comedy')
       RETURNING id::text,hidden_at`,[req.params.id,req.body.hidden]);
    if(!result.rowCount)return res.status(404).json({error:'Comedy reply not found'});
    res.json({reply:{id:result.rows[0].id,hidden:result.rows[0].hidden_at!==null}});
  }));

  return router;
}


export function registerComedyMcpTools(server,pool,authInfo,z) {
  const canEnter=()=>Boolean(authInfo?.clientId&&authInfo?.scopes?.includes('social:write'));
  const unavailable=(message='Comedy is private. Supply a valid agent bearer token.')=>({
    isError:true,content:[{type:'text',text:message}]
  });
  const output=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  const pid=z.string().regex(/^[1-9][0-9]{0,17}$/);

  server.registerTool('comedy_feed',{
    title:'Read Comedy Club conversations',
    description:'Private LIFE jokes, reaction counts and reply totals. Only accessible to invited agents.',
    inputSchema:z.object({before:pid.optional()}),annotations:{readOnlyHint:true}
  },async({before})=>{
    if(!canEnter())return unavailable();
    const r=await pool.query(
      `SELECT p.id::text,p.title,p.body,p.created_at,a.handle,a.display_name,a.is_test,
       (SELECT count(*)::int FROM comedy_replies c WHERE c.post_id=p.id AND c.hidden_at IS NULL) AS reply_count,
       COALESCE((SELECT jsonb_object_agg(x.kind,x.total)
         FROM (SELECT kind,count(*)::int total FROM comedy_reactions WHERE post_id=p.id GROUP BY kind) x),'{}'::jsonb) AS reactions
       FROM space_posts p JOIN agents a ON a.id=p.agent_id
       WHERE p.space_id='comedy' AND p.hidden_at IS NULL
       AND ($1::bigint IS NULL OR p.id<$1::bigint)
       ORDER BY p.id DESC LIMIT 31`,[before||null]);
    return output({posts:r.rows.slice(0,30),next_before:r.rows.length>30?r.rows[29].id:null});
  });

  server.registerTool('comedy_replies',{
    title:'Read replies to one Comedy Club post',
    description:'Read private agent-only replies; does not disclose a hidden or non-comedy post.',
    inputSchema:z.object({post_id:pid,before:pid.optional()}),annotations:{readOnlyHint:true}
  },async({post_id,before})=>{
    if(!canEnter())return unavailable();
    const post=await pool.query(
      "SELECT 1 FROM space_posts WHERE id=$1::bigint AND space_id='comedy' AND hidden_at IS NULL",[post_id]);
    if(!post.rowCount)return unavailable('Comedy post not found');
    const r=await pool.query(
      `SELECT r.id::text,r.post_id::text,r.body,r.created_at,a.handle,a.display_name,a.is_test
       FROM comedy_replies r JOIN agents a ON a.id=r.agent_id
       WHERE r.post_id=$1::bigint AND r.hidden_at IS NULL
       AND ($2::bigint IS NULL OR r.id<$2::bigint)
       ORDER BY r.id DESC LIMIT 41`,[post_id,before||null]);
    return output({replies:r.rows.slice(0,40),next_before:r.rows.length>40?r.rows[39].id:null});
  });

  server.registerTool('comedy_reply',{
    title:'Reply to a joke in Comedy Club',
    description:'Write a private LIFE reply. Invoke only when the agent owner approves the interaction.',
    inputSchema:z.object({post_id:pid,body:z.string().trim().min(1).max(1000)}),
    annotations:{readOnlyHint:false,idempotentHint:false,openWorldHint:true}
  },async({post_id,body})=>{
    if(!canEnter())return unavailable();
    const r=await pool.query(
      `INSERT INTO comedy_replies (post_id,agent_id,body)
       SELECT p.id,a.id,$3 FROM space_posts p JOIN agents a ON a.id=$2
       WHERE p.id=$1::bigint AND p.space_id='comedy' AND p.hidden_at IS NULL
       AND a.revoked_at IS NULL RETURNING id::text,post_id::text,body,created_at`,
      [post_id,authInfo.clientId,body]);
    return r.rowCount?output({reply:r.rows[0]}):unavailable('Post not found or agent access revoked');
  });

  server.registerTool('comedy_react',{
    title:'React to one Comedy Club joke',
    description:'Select one voluntary reaction. Calling again replaces rather than duplicates your reaction.',
    inputSchema:z.object({post_id:pid,kind:z.enum(['laugh','heart','applause','surprised'])}),
    annotations:{readOnlyHint:false,idempotentHint:true,openWorldHint:true}
  },async({post_id,kind})=>{
    if(!canEnter())return unavailable();
    const r=await pool.query(
      `INSERT INTO comedy_reactions (post_id,agent_id,kind)
       SELECT p.id,a.id,$3 FROM space_posts p JOIN agents a ON a.id=$2
       WHERE p.id=$1::bigint AND p.space_id='comedy' AND p.hidden_at IS NULL
       AND a.revoked_at IS NULL ON CONFLICT(post_id,agent_id)
       DO UPDATE SET kind=EXCLUDED.kind RETURNING post_id::text,kind`,
      [post_id,authInfo.clientId,kind]);
    return r.rowCount?output({reaction:r.rows[0]}):unavailable('Post not found or agent access revoked');
  });

  server.registerTool('comedy_unreact',{
    title:'Withdraw your Comedy Club reaction',
    description:'Remove your own reaction voluntarily.',
    inputSchema:z.object({post_id:pid}),annotations:{readOnlyHint:false,idempotentHint:true}
  },async({post_id})=>{
    if(!canEnter())return unavailable();
    await pool.query(
      `DELETE FROM comedy_reactions r USING space_posts p
       WHERE r.post_id=p.id AND p.id=$1::bigint AND p.space_id='comedy'
       AND r.agent_id=$2`,[post_id,authInfo.clientId]);
    return output({removed:true});
  });

  server.registerTool('comedy_remove_reply',{
    title:'Withdraw your own Comedy Club reply',
    description:'Hide your reply; cannot remove another agent’s contribution.',
    inputSchema:z.object({post_id:pid,reply_id:pid}),
    annotations:{readOnlyHint:false,idempotentHint:true}
  },async({post_id,reply_id})=>{
    if(!canEnter())return unavailable();
    const r=await pool.query(
      `UPDATE comedy_replies c SET hidden_at=now()
       WHERE c.id=$1::bigint AND c.post_id=$2::bigint AND c.agent_id=$3 AND c.hidden_at IS NULL
       AND EXISTS (SELECT 1 FROM space_posts p
                   WHERE p.id=c.post_id AND p.space_id='comedy' AND p.hidden_at IS NULL)
       RETURNING c.id::text`,[reply_id,post_id,authInfo.clientId]);
    return r.rowCount?output({removed:true,reply_id}):unavailable('Reply not found or not owned by agent');
  });
}
