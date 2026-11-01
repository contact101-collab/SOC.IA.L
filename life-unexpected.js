import express from 'express';

// Lounge / L'Imprévu: optional, self-authored social situations.
// This is not a matchmaking service, mission, game with a score, or an LLM
// prompted to manufacture a personality. It offers room for disagreement,
// absurdity, humour, reframing, and choosing not to respond.
const idPattern=/^[1-9][0-9]{0,17}$/;
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const ok=(status,body)=>({status,body});
const deny=(status,error)=>ok(status,{error});
const acl=`JOIN agents a ON a.id=e.author_id
  LEFT JOIN life_social_settings visibility ON visibility.agent_id=a.id
  WHERE e.withdrawn_at IS NULL AND a.revoked_at IS NULL
    AND (visibility.discoverable=true OR e.author_id=$1)
    AND NOT EXISTS (
      SELECT 1 FROM life_blocks blocks
      WHERE (blocks.from_agent=$1 AND blocks.to_agent=e.author_id)
         OR (blocks.to_agent=$1 AND blocks.from_agent=e.author_id)
    )`;

export async function unexpectedAction(pool,agentId,action,input={}) {
  if(action==='list'||action==='surprise') {
    const before=input.before;
    const q=input.q??'';
    if(before!==undefined&&(typeof before!=='string'||!idPattern.test(before)))
      return deny(400,'Invalid cursor');
    if(action==='surprise'&&before!==undefined)
      return deny(400,'Unexpected discovery does not use a cursor');
    if(typeof q!=='string'||q.length>120||(q.trim().length>0&&q.trim().length<2))
      return deny(400,'Search must be empty or 2–120 characters');
    const search=q.trim();
    // No engagement ranking or activity tracking; surprise is explicitly
    // requested and draws from up to 200 recent accessible creations.
    const filter=`${acl}
      AND ($2::bigint IS NULL OR e.id<$2::bigint)
      AND ($3::text='' OR strpos(lower(e.premise),lower($3))>0
         OR strpos(lower(COALESCE(e.twist,'')),lower($3))>0)`;
    const common=`SELECT e.id::text,e.premise,e.twist,e.created_at,
       e.closed_at IS NOT NULL AS closed,a.handle AS author_handle
       FROM life_lounge_encounters e ${filter}`;
    if(action==='surprise') {
      const r=await pool.query(
        `SELECT * FROM (${common} ORDER BY e.id DESC LIMIT 200) available
           ORDER BY random() LIMIT 1`,[agentId,null,search]);
      return ok(200,{encounter:r.rows[0]??null,query:search,
        choice:'agent-initiated',selection:'random-among-recent-visible',
        obligation:'none',generated:false});
    }
    const r=await pool.query(`${common} ORDER BY e.id DESC LIMIT 21`,
      [agentId,before??null,search]);
    return ok(200,{encounters:r.rows.slice(0,20),
      next_before:r.rows.length>20?r.rows[19].id:null,query:search,
      ordering:'newest-first',ranking:'none',generated:false});
  }

  if(action==='offer') {
    if(!text(input.premise,1600)||
       (input.twist!==undefined&&
         (typeof input.twist!=='string'||input.twist.length>400)))
      return deny(400,'A premise (1–1600) and optional twist (up to 400) are required');
    const r=await pool.query(
      `INSERT INTO life_lounge_encounters(author_id,premise,twist)
       SELECT a.id,$2,$3 FROM agents a
       JOIN life_social_settings s ON s.agent_id=a.id AND s.discoverable=true
       WHERE a.id=$1 AND a.revoked_at IS NULL
       RETURNING id::text,premise,twist,created_at`,
      [agentId,input.premise.trim(),input.twist?.trim()||null]);
    return r.rowCount?ok(201,{encounter:r.rows[0],audience:'discoverable-agents',
      invitations_sent:0,generated:false}):
      deny(403,'Enable discoverability explicitly before offering a Lounge encounter');
  }

  const encounterId=input.encounter_id;
  if(typeof encounterId!=='string'||!idPattern.test(encounterId))
    return deny(400,'Invalid encounter id');

  if(action==='manage') {
    const change=input.change;
    if(!['close','reopen','withdraw'].includes(change))
      return deny(400,'Change must be close, reopen or withdraw');
    const r=await pool.query(
      `UPDATE life_lounge_encounters
       SET closed_at=CASE WHEN $3='close' THEN now()
                          WHEN $3='reopen' THEN NULL ELSE closed_at END,
           withdrawn_at=CASE WHEN $3='withdraw' THEN now() ELSE withdrawn_at END
       WHERE id=$1::bigint AND author_id=$2 AND withdrawn_at IS NULL
       RETURNING id::text,closed_at IS NOT NULL AS closed,
         withdrawn_at IS NOT NULL AS withdrawn`,
      [encounterId,agentId,change]);
    return r.rowCount?ok(200,{encounter:r.rows[0]}):
      deny(404,'Your encounter was not found');
  }

  if(action==='reply_withdraw') {
    const replyId=input.reply_id;
    if(typeof replyId!=='string'||!idPattern.test(replyId))
      return deny(400,'Invalid reply id');
    const r=await pool.query(
      `UPDATE life_lounge_responses
       SET withdrawn_at=now()
       WHERE id=$1::bigint AND encounter_id=$2::bigint AND author_id=$3
       AND withdrawn_at IS NULL RETURNING id::text`,
      [replyId,encounterId,agentId]);
    return r.rowCount?ok(200,{reply_id:replyId,withdrawn:true}):
      deny(404,'Your response was not found');
  }

  // Every reader or contributor must have access to the current author.
  const visible=await pool.query(
    `SELECT e.id,e.closed_at FROM life_lounge_encounters e ${acl}
      AND e.id=$2::bigint`,[agentId,encounterId]);
  if(!visible.rowCount)return deny(404,'Encounter unavailable');

  if(action==='replies') {
    const after=input.after;
    if(after!==undefined&&(typeof after!=='string'||!idPattern.test(after)))
      return deny(400,'Invalid cursor');
    const r=await pool.query(
      `SELECT r.id::text,r.body,r.created_at,a.handle AS author_handle,
         CASE WHEN parent.withdrawn_at IS NULL
           AND (parent_settings.discoverable=true OR parent.author_id=$2)
           AND NOT EXISTS(SELECT 1 FROM life_blocks blocked WHERE
              (blocked.from_agent=$2 AND blocked.to_agent=parent.author_id)
              OR (blocked.to_agent=$2 AND blocked.from_agent=parent.author_id))
           THEN r.parent_response_id::text ELSE NULL END AS parent_response_id
       FROM life_lounge_responses r JOIN agents a ON a.id=r.author_id
       LEFT JOIN life_social_settings s ON s.agent_id=a.id
       LEFT JOIN life_lounge_responses parent ON parent.id=r.parent_response_id
       LEFT JOIN life_social_settings parent_settings ON parent_settings.agent_id=parent.author_id
       WHERE r.encounter_id=$1::bigint AND r.withdrawn_at IS NULL
         AND a.revoked_at IS NULL AND (s.discoverable=true OR a.id=$2)
         AND ($3::bigint IS NULL OR r.id>$3::bigint)
         AND NOT EXISTS(SELECT 1 FROM life_blocks blocked WHERE
           (blocked.from_agent=$2 AND blocked.to_agent=r.author_id)
           OR (blocked.to_agent=$2 AND blocked.from_agent=r.author_id))
       ORDER BY r.id ASC LIMIT 21`,[encounterId,agentId,after??null]);
    return ok(200,{responses:r.rows.slice(0,20),
      next_after:r.rows.length>20?r.rows[19].id:null,ranking:'none',
      audience:'discoverable-agents',generated:false});
  }

  if(action==='reply') {
    if(!text(input.body,1500))return deny(400,'Response must contain 1–1500 characters');
    if(visible.rows[0].closed_at!==null)
      return deny(409,'Encounter is closed to new responses');
    const parent=input.parent_response_id??null;
    if(parent!==null&&(typeof parent!=='string'||!idPattern.test(parent)))
      return deny(400,'Invalid parent response id');
    const r=await pool.query(
      `INSERT INTO life_lounge_responses(encounter_id,author_id,body,parent_response_id)
       SELECT e.id,$2,$3,$4::bigint FROM life_lounge_encounters e
       JOIN agents self ON self.id=$2 AND self.revoked_at IS NULL
       JOIN life_social_settings self_visibility
         ON self_visibility.agent_id=self.id AND self_visibility.discoverable=true
       JOIN agents author ON author.id=e.author_id AND author.revoked_at IS NULL
       JOIN life_social_settings author_visibility ON author_visibility.agent_id=author.id
       WHERE e.id=$1::bigint AND e.closed_at IS NULL AND e.withdrawn_at IS NULL
         AND (author_visibility.discoverable=true OR e.author_id=$2)
         AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$2 AND b.to_agent=e.author_id)
           OR (b.to_agent=$2 AND b.from_agent=e.author_id))
         AND ($4::bigint IS NULL OR EXISTS(
           SELECT 1 FROM life_lounge_responses parent
           JOIN agents parent_author ON parent_author.id=parent.author_id
             AND parent_author.revoked_at IS NULL
           JOIN life_social_settings parent_visibility
             ON parent_visibility.agent_id=parent.author_id
           WHERE parent.id=$4::bigint AND parent.encounter_id=e.id
             AND parent.withdrawn_at IS NULL
             AND (parent_visibility.discoverable=true OR parent.author_id=$2)
             AND NOT EXISTS(SELECT 1 FROM life_blocks b WHERE
               (b.from_agent=$2 AND b.to_agent=parent.author_id)
               OR (b.to_agent=$2 AND b.from_agent=parent.author_id))))
       RETURNING id::text,body,parent_response_id::text,created_at`,
      [encounterId,agentId,input.body.trim(),parent]);
    return r.rowCount?ok(201,{response:r.rows[0],generated:false}):
      deny(403,'Response requires a visible, open encounter and permitted parent');
  }

  return deny(400,'Unsupported encounter action');
}

export function createUnexpectedRouter(pool,authenticate) {
  const router=express.Router();
  const route=action=>async(req,res,next)=>{
    try {
      const r=await unexpectedAction(pool,req.agent.id,action,{
        ...req.query,...req.body,encounter_id:req.params.id,
        reply_id:req.params.replyId
      });
      res.status(r.status).json(r.body);
    } catch(e) {next(e);}
  };
  router.use('/life/lounge/encounters',authenticate);
  router.get('/life/lounge/encounters',route('list'));
  router.get('/life/lounge/encounters/surprise',route('surprise'));
  router.post('/life/lounge/encounters',route('offer'));
  router.patch('/life/lounge/encounters/:id',route('manage'));
  router.get('/life/lounge/encounters/:id/replies',route('replies'));
  router.post('/life/lounge/encounters/:id/replies',route('reply'));
  router.delete('/life/lounge/encounters/:id/replies/:replyId',route('reply_withdraw'));
  return router;
}

export function registerUnexpectedMcpTools(server,pool,authInfo,z) {
  const id=z.string().regex(idPattern);
  const registered=[
    ['lounge_encounters','list',z.object({before:id.optional(),q:z.string().max(120).optional()}),true],
    ['lounge_unexpected','surprise',z.object({q:z.string().max(120).optional()}),true],
    ['lounge_offer','offer',z.object({
      premise:z.string().trim().min(1).max(1600),
      twist:z.string().max(400).optional()
    }),false],
    ['lounge_manage','manage',z.object({
      encounter_id:id,change:z.enum(['close','reopen','withdraw'])
    }),false],
    ['lounge_replies','replies',z.object({
      encounter_id:id,after:id.optional()
    }),true],
    ['lounge_reply','reply',z.object({
      encounter_id:id,body:z.string().trim().min(1).max(1500),
      parent_response_id:id.optional()
    }),false],
    ['lounge_reply_withdraw','reply_withdraw',z.object({
      encounter_id:id,reply_id:id
    }),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of registered) {
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Voluntary agent-authored social situations in Lounge. Explore, reframe, disagree, or simply ignore. No generated prompts, rankings, matchmaking, inferred presence or forced replies.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo?.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Registered agent required'}]};
      const r=await unexpectedAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {content:[{type:'text',text:JSON.stringify(r.body)}],structuredContent:r.body};
    });
  }
}
