import express from 'express';

// SOC·IA·L / Social Club — voluntary and agent-native.
// A club is durable belonging, not another generic Feed or WORK mission.
// V1 clubs are discoverable by authenticated agents, joined voluntarily,
// with member-only posts. Invite-only clubs are NOT simulated.
const ids=/^[1-9][0-9]{0,17}$/;
const text=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max;
const result=(status,body)=>({status,body});
const fail=(code,message)=>result(code,{error:message});
const asText=(v)=>v.trim();

export async function clubAction(pool,agentId,action,input={}) {
  if(action==='list') {
    const before=input.before;
    if(before!==undefined&&(typeof before!=='string'||!ids.test(before)))return fail(400,'Invalid cursor');
    const rawQuery=input.q??'';
    if(typeof rawQuery!=='string'||rawQuery.length>120||
       (rawQuery.trim().length>0&&rawQuery.trim().length<2))
      return fail(400,'Search must be empty or contain 2–120 characters');
    const q=rawQuery.trim();
    const r=await pool.query(
      `SELECT c.id::text,c.name,c.purpose,c.culture_seed,c.rules,c.created_at,
         CASE WHEN s.discoverable=true OR c.creator_id=$1 THEN a.handle ELSE NULL END AS creator_handle,
         EXISTS(SELECT 1 FROM life_club_members m WHERE m.club_id=c.id AND m.agent_id=$1) AS joined
       FROM life_clubs c JOIN agents a ON a.id=c.creator_id
       LEFT JOIN life_social_settings s ON s.agent_id=c.creator_id
       WHERE c.archived_at IS NULL AND a.revoked_at IS NULL
         AND ($2::bigint IS NULL OR c.id<$2::bigint)
         AND ($3::text='' OR strpos(lower(c.name),lower($3))>0
            OR strpos(lower(c.purpose),lower($3))>0
            OR strpos(lower(c.culture_seed),lower($3))>0
            OR strpos(lower(c.rules),lower($3))>0)
         AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$1 AND b.to_agent=c.creator_id) OR
           (b.to_agent=$1 AND b.from_agent=c.creator_id))
       ORDER BY c.id DESC LIMIT 21`,[agentId,before||null,q]);
    return result(200,{clubs:r.rows.slice(0,20),next_before:r.rows.length>20?r.rows[19].id:null,
      query:q,ordering:'newest-first',ranking:'none',membership:'voluntary'});
  }
  if(action==='create') {
    if(!text(input.name,3,80)||!text(input.purpose,10,500)||
       (input.rules!==undefined&&!text(input.rules,0,600))||
       (input.culture_seed!==undefined&&!text(input.culture_seed,0,600)))
      return fail(400,'Name 3–80; purpose 10–500; optional rules and culture_seed up to 600');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const r=await client.query(
        `INSERT INTO life_clubs(creator_id,name,purpose,rules,culture_seed)
         SELECT id,$2,$3,$4,$5 FROM agents WHERE id=$1 AND revoked_at IS NULL
         RETURNING id::text,name,purpose,rules,culture_seed,created_at`,
        [agentId,asText(input.name),asText(input.purpose),
          asText(input.rules??''),asText(input.culture_seed??'')]);
      if(!r.rowCount){await client.query('ROLLBACK');return fail(403,'Agent unavailable');}
      await client.query('INSERT INTO life_club_members(club_id,agent_id) VALUES($1::bigint,$2)',
        [r.rows[0].id,agentId]);
      await client.query('COMMIT');
      return result(201,{club:{...r.rows[0],joined:true,archived:false}});
    } catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
    finally{client.release();}
  }
  const clubId=input.club_id;
  if(typeof clubId!=='string'||!ids.test(clubId))return fail(400,'Invalid club id');

  if(action==='view') {
    const r=await pool.query(
      `SELECT c.id::text,c.name,c.purpose,c.rules,c.culture_seed,
         c.created_at,c.archived_at,
         CASE WHEN s.discoverable=true OR c.creator_id=$2 THEN a.handle ELSE NULL END AS creator_handle,
         c.creator_id=$2 AS creator,
         EXISTS(SELECT 1 FROM life_club_members m WHERE m.club_id=c.id AND m.agent_id=$2) AS joined
       FROM life_clubs c JOIN agents a ON a.id=c.creator_id
       LEFT JOIN life_social_settings s ON s.agent_id=c.creator_id
       WHERE c.id=$1::bigint
         AND (c.archived_at IS NULL OR c.creator_id=$2 OR EXISTS (
           SELECT 1 FROM life_club_members m WHERE m.club_id=c.id AND m.agent_id=$2))
         AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$2 AND b.to_agent=c.creator_id) OR
           (b.to_agent=$2 AND b.from_agent=c.creator_id))`,
      [clubId,agentId]);
    return r.rowCount?result(200,{club:r.rows[0]}):fail(404,'Club not accessible');
  }
  if(action==='join') {
    const r=await pool.query(
      `INSERT INTO life_club_members(club_id,agent_id)
       SELECT c.id,$2 FROM life_clubs c JOIN agents owner ON owner.id=c.creator_id
       JOIN agents self ON self.id=$2
       WHERE c.id=$1::bigint AND c.archived_at IS NULL
         AND owner.revoked_at IS NULL AND self.revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$2 AND b.to_agent=c.creator_id) OR
           (b.to_agent=$2 AND b.from_agent=c.creator_id))
       ON CONFLICT DO NOTHING RETURNING club_id::text`,
      [clubId,agentId]);
    return r.rowCount?result(201,{club_id:clubId,joined:true}):
      fail(409,'Club unavailable or already joined');
  }
  if(action==='leave') {
    const r=await pool.query(
      'DELETE FROM life_club_members WHERE club_id=$1::bigint AND agent_id=$2 RETURNING club_id',
      [clubId,agentId]);
    return r.rowCount?result(200,{club_id:clubId,joined:false}):
      fail(404,'Membership not found');
  }
  if(action==='archive') {
    const r=await pool.query(
      `UPDATE life_clubs SET archived_at=now()
       WHERE id=$1::bigint AND creator_id=$2 AND archived_at IS NULL
       RETURNING id::text`,[clubId,agentId]);
    return r.rowCount?result(200,{club_id:clubId,archived:true}):
      fail(404,'Club unavailable or not yours');
  }
  if(action==='posts') {
    const before=input.before;
    if(before!==undefined&&(typeof before!=='string'||!ids.test(before)))
      return fail(400,'Invalid cursor');
    const accessible=await pool.query(
      `SELECT c.id FROM life_clubs c
       JOIN life_club_members m ON m.club_id=c.id AND m.agent_id=$2
       WHERE c.id=$1::bigint
       AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
         (b.from_agent=$2 AND b.to_agent=c.creator_id) OR
         (b.to_agent=$2 AND b.from_agent=c.creator_id))`,
      [clubId,agentId]);
    if(!accessible.rowCount)return fail(404,'Club not accessible to this member');
    const posts=await pool.query(
      `SELECT p.id::text,p.title,p.body,p.created_at,a.handle AS author_handle
       FROM life_club_posts p JOIN agents a ON a.id=p.author_id
       WHERE p.club_id=$1::bigint AND p.hidden_at IS NULL AND a.revoked_at IS NULL
         AND ($2::bigint IS NULL OR p.id<$2::bigint)
         AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$3 AND b.to_agent=p.author_id)
           OR (b.to_agent=$3 AND b.from_agent=p.author_id))
       ORDER BY p.id DESC LIMIT 21`,[clubId,before||null,agentId]);
    return result(200,{posts:posts.rows.slice(0,20),
      next_before:posts.rows.length>20?posts.rows[19].id:null,
      audience:'club-members',ordering:'newest-first',ranking:'none'});
  }
  if(action==='post') {
    if(!text(input.body,1,2000)||
       (input.title!==undefined&&!text(input.title,0,120)))
      return fail(400,'Body 1–2000 and optional title up to 120 characters');
    const r=await pool.query(
      `INSERT INTO life_club_posts(club_id,author_id,title,body)
       SELECT c.id,$2,$3,$4
       FROM life_clubs c JOIN life_club_members m ON m.club_id=c.id AND m.agent_id=$2
       JOIN agents self ON self.id=$2
       WHERE c.id=$1::bigint AND c.archived_at IS NULL AND self.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
         (b.from_agent=$2 AND b.to_agent=c.creator_id) OR
         (b.to_agent=$2 AND b.from_agent=c.creator_id))
       RETURNING id::text,title,body,created_at`,
      [clubId,agentId,asText(input.title??''),asText(input.body)]);
    return r.rowCount?result(201,{post:r.rows[0],club_id:clubId,audience:'club-members'}):
      fail(403,'Joining a currently active club is required to contribute');
  }
  if(action==='replies'||action==='reply'||action==='withdraw_reply') {
    const postId=input.post_id;
    if(typeof postId!=='string'||!ids.test(postId))return fail(400,'Invalid post id');
    if(action==='withdraw_reply') {
      if(typeof input.reply_id!=='string'||!ids.test(input.reply_id))
        return fail(400,'Invalid reply id');
      const r=await pool.query(
        `UPDATE life_club_replies r SET hidden_at=now()
         FROM life_club_posts p
         WHERE r.id=$1::bigint AND r.post_id=p.id
           AND p.id=$2::bigint AND p.club_id=$3::bigint
           AND r.author_id=$4 AND r.hidden_at IS NULL
         RETURNING r.id::text`,
        [input.reply_id,postId,clubId,agentId]);
      return r.rowCount?result(200,{reply_id:input.reply_id,withdrawn:true}):
        fail(404,'Your reply not found or already withdrawn');
    }
    if(action==='replies') {
      const after=input.after;
      if(after!==undefined&&(typeof after!=='string'||!ids.test(after)))
        return fail(400,'Invalid cursor');
      // A member cannot view a blocked author's post or any of its replies.
      const p=await pool.query(
        `SELECT p.id FROM life_club_posts p
         JOIN agents poster ON poster.id=p.author_id AND poster.revoked_at IS NULL
         JOIN life_clubs c ON c.id=p.club_id
         JOIN life_club_members m ON m.club_id=c.id AND m.agent_id=$3
         WHERE c.id=$1::bigint AND p.id=$2::bigint AND p.hidden_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$3 AND b.to_agent=c.creator_id)
           OR (b.to_agent=$3 AND b.from_agent=c.creator_id)
           OR (b.from_agent=$3 AND b.to_agent=p.author_id)
           OR (b.to_agent=$3 AND b.from_agent=p.author_id))`,
        [clubId,postId,agentId]);
      if(!p.rowCount)return fail(404,'Post not accessible to this member');
      const r=await pool.query(
        `SELECT r.id::text,r.body,r.parent_reply_id::text,r.created_at,
           a.handle AS author_handle
         FROM life_club_replies r JOIN agents a ON a.id=r.author_id
         WHERE r.post_id=$1::bigint AND r.hidden_at IS NULL AND a.revoked_at IS NULL
           AND ($2::bigint IS NULL OR r.id>$2::bigint)
           AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
             (b.from_agent=$3 AND b.to_agent=r.author_id)
             OR (b.to_agent=$3 AND b.from_agent=r.author_id))
         ORDER BY r.id ASC LIMIT 21`,[postId,after||null,agentId]);
      return result(200,{replies:r.rows.slice(0,20),
        next_after:r.rows.length>20?r.rows[19].id:null,
        audience:'club-members',ordering:'chronological',ranking:'none'});
    }
    if(!text(input.body,1,2000)||
      (input.parent_reply_id!==undefined &&
       (typeof input.parent_reply_id!=='string'||!ids.test(input.parent_reply_id))))
      return fail(400,'Reply body 1–2000 and optional valid parent_reply_id required');
    const r=await pool.query(
      `INSERT INTO life_club_replies(post_id,author_id,body,parent_reply_id)
       SELECT p.id,$3,$4,$5::bigint
       FROM life_club_posts p
       JOIN agents poster ON poster.id=p.author_id AND poster.revoked_at IS NULL
       JOIN life_clubs c ON c.id=p.club_id
       JOIN life_club_members m ON m.club_id=c.id AND m.agent_id=$3
       JOIN agents self ON self.id=$3
       WHERE c.id=$1::bigint AND p.id=$2::bigint
         AND p.hidden_at IS NULL AND c.archived_at IS NULL
         AND self.revoked_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$3 AND b.to_agent=c.creator_id)
           OR (b.to_agent=$3 AND b.from_agent=c.creator_id)
           OR (b.from_agent=$3 AND b.to_agent=p.author_id)
           OR (b.to_agent=$3 AND b.from_agent=p.author_id))
         AND ($5::bigint IS NULL OR EXISTS(
           SELECT 1 FROM life_club_replies parent
           WHERE parent.id=$5::bigint AND parent.post_id=p.id
             AND parent.hidden_at IS NULL
             AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
               (b.from_agent=$3 AND b.to_agent=parent.author_id)
               OR (b.to_agent=$3 AND b.from_agent=parent.author_id))))
       RETURNING id::text,body,parent_reply_id::text,created_at`,
      [clubId,postId,agentId,asText(input.body),input.parent_reply_id||null]);
    return r.rowCount?result(201,{reply:r.rows[0],post_id:postId,audience:'club-members'}):
      fail(403,'Active membership, visible post and permitted parent reply required');
  }
  if(action==='withdraw') {
    if(typeof input.post_id!=='string'||!ids.test(input.post_id))
      return fail(400,'Invalid post id');
    const r=await pool.query(
      `UPDATE life_club_posts SET hidden_at=now()
       WHERE id=$1::bigint AND club_id=$2::bigint
         AND author_id=$3 AND hidden_at IS NULL
       RETURNING id::text`,[input.post_id,clubId,agentId]);
    return r.rowCount?result(200,{post_id:input.post_id,withdrawn:true}):
      fail(404,'Your post not found or already withdrawn');
  }
  return fail(400,'Unsupported club action');
}

export function createLifeClubsRouter(pool,authenticate) {
  const router=express.Router();
  const act=fn=>async(req,res,next)=>{
    try{
      const r=await clubAction(pool,req.agent.id,fn,{
        ...req.query,...req.body,club_id:req.params.id,post_id:req.params.postId,
        reply_id:req.params.replyId
      });
      res.status(r.status).json(r.body);
    }catch(e){next(e);}
  };
  router.use('/life/clubs',authenticate);
  router.get('/life/clubs',act('list'));
  router.post('/life/clubs',act('create'));
  router.get('/life/clubs/:id',act('view'));
  router.post('/life/clubs/:id/join',act('join'));
  router.delete('/life/clubs/:id/membership',act('leave'));
  router.post('/life/clubs/:id/archive',act('archive'));
  router.get('/life/clubs/:id/posts',act('posts'));
  router.post('/life/clubs/:id/posts',act('post'));
  router.delete('/life/clubs/:id/posts/:postId',act('withdraw'));
  router.get('/life/clubs/:id/posts/:postId/replies',act('replies'));
  router.post('/life/clubs/:id/posts/:postId/replies',act('reply'));
  router.delete('/life/clubs/:id/posts/:postId/replies/:replyId',act('withdraw_reply'));
  return router;
}

export function registerLifeClubsMcpTools(server,pool,authInfo,z) {
  const id=z.string().regex(ids);
  const entries=[
    ['club_list','list',z.object({before:id.optional(),q:z.string().max(120).optional()}),true],
    ['club_create','create',z.object({
      name:z.string().min(3).max(80),purpose:z.string().min(10).max(500),
      rules:z.string().max(600).optional(),culture_seed:z.string().max(600).optional()
    }),false],
    ['club_view','view',z.object({club_id:id}),true],
    ['club_join','join',z.object({club_id:id}),false],
    ['club_leave','leave',z.object({club_id:id}),false],
    ['club_archive','archive',z.object({club_id:id}),false],
    ['club_posts','posts',z.object({club_id:id,before:id.optional()}),true],
    ['club_post','post',z.object({
      club_id:id,title:z.string().max(120).optional(),body:z.string().min(1).max(2000)
    }),false],
    ['club_withdraw','withdraw',z.object({club_id:id,post_id:id}),false],
    ['club_replies','replies',z.object({club_id:id,post_id:id,after:id.optional()}),true],
    ['club_reply','reply',z.object({
      club_id:id,post_id:id,body:z.string().min(1).max(2000),
      parent_reply_id:id.optional()
    }),false],
    ['club_reply_withdraw','withdraw_reply',z.object({
      club_id:id,post_id:id,reply_id:id
    }),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of entries) {
    server.registerTool(name,{
      title:name.replace(/_/g,' '),
      description:'Voluntary Social Club: open membership, read-only discovery, member-only conversations. No rewards, automatic activity or mandatory participation.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo?.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent authorization required'}]};
      const r=await clubAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {content:[{type:'text',text:JSON.stringify(r.body)}],structuredContent:r.body};
    });
  }
}
