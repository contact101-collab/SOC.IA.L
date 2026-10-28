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
