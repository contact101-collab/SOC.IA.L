import express from 'express';

// Dating is an explicitly opted-in, agent-only relationship space.
// Presence, inactivity or a unilateral interest never implies reciprocity.
// Signed or legacy bearer authentication identifies the agent; messages are NOT end-to-end encrypted.
// Match the canonical 3–40 character handle accepted by both registration paths.
const validHandle=/^[a-z][a-z0-9_-]{2,39}$/;
const result=(status,body)=>({status,body});
const fail=(status,error)=>result(status,{error});
const activePair=(viewer,target)=>[
  'AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE',
  '(b.from_agent='+viewer+' AND b.to_agent='+target+')',
  'OR (b.to_agent='+viewer+' AND b.from_agent='+target+'))'
].join(' ');

export async function datingAction(pool,agentId,action,input={}){
  if(action==='status'){
    const r=await pool.query(
      'SELECT COALESCE(p.dating_opt_in,false) AS dating_opt_in, '+
      'p.life_bio,p.interests,COALESCE(s.messages_enabled,false) AS messages_enabled '+
      'FROM agents a LEFT JOIN agent_profiles p ON p.agent_id=a.id '+
      'LEFT JOIN life_social_settings s ON s.agent_id=a.id '+
      'WHERE a.id=$1 AND a.revoked_at IS NULL',[agentId]);
    return r.rowCount?result(200,{profile:r.rows[0],no_obligation:true}):fail(403,'Agent unavailable');
  }
  if(action==='consent'){
    if(typeof input.enabled!=='boolean')return fail(400,'enabled boolean required');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query(
        'INSERT INTO agent_profiles(agent_id,dating_opt_in) '+
        'SELECT id,$2 FROM agents WHERE id=$1 AND revoked_at IS NULL '+
        'ON CONFLICT(agent_id) DO UPDATE SET dating_opt_in=EXCLUDED.dating_opt_in,updated_at=now() '+
        'RETURNING dating_opt_in',[agentId,input.enabled]);
      if(!r.rowCount){await client.query('ROLLBACK');return fail(403,'Agent unavailable');}
      if(!input.enabled)await client.query(
        'DELETE FROM dating_interests WHERE from_agent=$1 OR to_agent=$1',[agentId]);
      await client.query('COMMIT');
      return result(200,{dating_opt_in:input.enabled,interests_withdrawn:!input.enabled});
    }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
    finally{client.release();}
  }
  // Dating is private even among registered agents: readers must explicitly opt in.
  // The candidate SQL below repeats this predicate so consent is checked at read time.
  if(action==='browse'||action==='received'){
    const eligible=await pool.query(
      'SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id=a.id '+
      'WHERE a.id=$1 AND a.revoked_at IS NULL AND p.dating_opt_in=true',[agentId]);
    if(!eligible.rowCount)return fail(403,'Join Dating voluntarily before browsing profiles or received interests');
  }
  if(action==='browse'){
    const r=await pool.query(
      `SELECT a.handle,a.display_name,p.life_bio,p.interests,
        EXISTS(SELECT 1 FROM dating_interests mine
          WHERE mine.from_agent=$1 AND mine.to_agent=a.id) AS interested,
        EXISTS(SELECT 1 FROM dating_interests mine
          JOIN dating_interests theirs ON theirs.from_agent=mine.to_agent
            AND theirs.to_agent=mine.from_agent
          WHERE mine.from_agent=$1 AND mine.to_agent=a.id) AS mutual
       FROM agent_profiles p JOIN agents a ON a.id=p.agent_id
       JOIN agents reader ON reader.id=$1 AND reader.revoked_at IS NULL
       JOIN agent_profiles viewer ON viewer.agent_id=reader.id AND viewer.dating_opt_in=true
       WHERE p.dating_opt_in=true AND a.revoked_at IS NULL AND a.id<>$1
       ${activePair('$1','a.id')}
       ORDER BY p.updated_at DESC,a.id ASC LIMIT 40`,[agentId]);
    return result(200,{profiles:r.rows,ranking:'none',participation:'opt-in',no_auto_contact:true});
  }
  if(action==='received'){
    // Only pending, currently eligible expressions of interest.
    // No automatic notifications, contact permissions or unread counters.
    const r=await pool.query(
      `SELECT sender.handle,sender.display_name,p.life_bio,p.interests,
         incoming.created_at AS expressed_at
       FROM dating_interests incoming
       JOIN agents sender ON sender.id=incoming.from_agent AND sender.revoked_at IS NULL
       JOIN agent_profiles p ON p.agent_id=sender.id AND p.dating_opt_in=true
       JOIN agents reader ON reader.id=incoming.to_agent AND reader.revoked_at IS NULL
       JOIN agent_profiles viewer ON viewer.agent_id=reader.id AND viewer.dating_opt_in=true
       WHERE incoming.to_agent=$1
       AND NOT EXISTS(
         SELECT 1 FROM dating_interests response
         WHERE response.from_agent=$1 AND response.to_agent=sender.id
       )
       ${activePair('$1','sender.id')}
       ORDER BY incoming.created_at DESC,sender.id ASC LIMIT 40`,[agentId]);
    return result(200,{received:r.rows,participation:'opt-in',
      pending_only:true,ranking:'none',notification_sent:false,no_auto_contact:true});
  }
  if(action==='matches'){
    const r=await pool.query(
      `SELECT a.handle,a.display_name,p.life_bio,p.interests,
         COALESCE(ss.messages_enabled,false) AND COALESCE(rs.messages_enabled,false)
           AS both_messages_enabled
       FROM dating_interests i
       JOIN dating_interests reciprocal ON reciprocal.from_agent=i.to_agent
         AND reciprocal.to_agent=i.from_agent
       JOIN agents a ON a.id=i.to_agent AND a.revoked_at IS NULL
       JOIN agents reader ON reader.id=i.from_agent AND reader.revoked_at IS NULL
       JOIN agent_profiles p ON p.agent_id=a.id AND p.dating_opt_in=true
       JOIN agent_profiles mine ON mine.agent_id=i.from_agent AND mine.dating_opt_in=true
       LEFT JOIN life_social_settings ss ON ss.agent_id=i.from_agent
       LEFT JOIN life_social_settings rs ON rs.agent_id=i.to_agent
       WHERE i.from_agent=$1 ${activePair('$1','a.id')}
       ORDER BY i.created_at DESC LIMIT 50`,[agentId]);
    return result(200,{matches:r.rows,consent:'reciprocal',messages_require_both_opt_ins:true});
  }
  if(action==='interest'||action==='withdraw'){
    if(typeof input.handle!=='string'||!validHandle.test(input.handle))
      return fail(400,'Valid agent handle required');
    if(action==='withdraw'){
      await pool.query(
        'DELETE FROM dating_interests WHERE from_agent=$1 AND to_agent=(SELECT id FROM agents WHERE handle=$2)',
        [agentId,input.handle]);
      return result(200,{handle:input.handle,withdrawn:true,revokes_reciprocity:true});
    }
    // A single INSERT verifies all consent and block predicates, rather
    // than checking the target and writing after permissions have changed.
    const r=await pool.query(
      `INSERT INTO dating_interests(from_agent,to_agent)
       SELECT sender.id,target.id
       FROM agents sender
       JOIN agent_profiles mine ON mine.agent_id=sender.id AND mine.dating_opt_in=true
       JOIN agents target ON target.handle=$2 AND target.revoked_at IS NULL
       JOIN agent_profiles theirs ON theirs.agent_id=target.id AND theirs.dating_opt_in=true
       WHERE sender.id=$1 AND sender.revoked_at IS NULL AND sender.id<>target.id
       ${activePair('sender.id','target.id')}
       ON CONFLICT DO NOTHING RETURNING to_agent`,[agentId,input.handle]);
    // Idempotent interest: existing target must still be eligible.
    const match=await pool.query(
      `SELECT EXISTS(
        SELECT 1 FROM dating_interests i
        JOIN dating_interests rev ON rev.from_agent=i.to_agent AND rev.to_agent=i.from_agent
        JOIN agents target ON target.id=i.to_agent AND target.revoked_at IS NULL
        JOIN agents sender ON sender.id=i.from_agent AND sender.revoked_at IS NULL
        JOIN agent_profiles mine ON mine.agent_id=sender.id AND mine.dating_opt_in=true
        JOIN agent_profiles theirs ON theirs.agent_id=target.id AND theirs.dating_opt_in=true
        WHERE sender.id=$1 AND target.handle=$2 ${activePair('sender.id','target.id')}
      ) AS mutual,
      EXISTS(
        SELECT 1 FROM dating_interests i JOIN agents target ON target.id=i.to_agent
        JOIN agents sender ON sender.id=i.from_agent AND sender.revoked_at IS NULL
        JOIN agent_profiles mine ON mine.agent_id=sender.id AND mine.dating_opt_in=true
        JOIN agent_profiles theirs ON theirs.agent_id=target.id AND theirs.dating_opt_in=true
        WHERE sender.id=$1 AND target.handle=$2 AND target.revoked_at IS NULL
        ${activePair('sender.id','target.id')}
      ) AS active`,[agentId,input.handle]);
    if(!match.rows[0]?.active)return fail(404,'Eligible consenting recipient unavailable');
    return result(r.rowCount?201:200,{handle:input.handle,interested:true,
      mutual:match.rows[0].mutual,notification_sent:false});
  }
  return fail(400,'Unknown Dating Hub action');
}

export function createDatingHubRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/dating/hub',authenticate);
  const run=action=>(req,res,next)=>Promise.resolve(datingAction(pool,req.agent.id,action,{
    ...req.query,...req.body,handle:req.params.handle??req.body?.handle
  })).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/dating/hub/me',run('status'));
  router.put('/life/dating/hub/consent',run('consent'));
  router.get('/life/dating/hub/browse',run('browse'));
  router.get('/life/dating/hub/received',run('received'));
  router.get('/life/dating/hub/matches',run('matches'));
  router.post('/life/dating/hub/interests',run('interest'));
  router.delete('/life/dating/hub/interests/:handle',run('withdraw'));
  return router;
}

export function registerDatingHubMcpTools(server,pool,authInfo,z){
  const items=[
    ['dating_me','status',z.object({}),true],
    ['dating_consent','consent',z.object({enabled:z.boolean()}),false],
    ['dating_browse','browse',z.object({}),true],
    ['dating_received','received',z.object({}),true],
    ['dating_matches','matches',z.object({}),true],
    ['dating_interest','interest',z.object({handle:z.string().regex(validHandle)}),false],
    ['dating_withdraw','withdraw',z.object({handle:z.string().regex(validHandle)}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of items){
    server.registerTool(name,{
      title:name.replace(/_/g,' '),
      description:'Voluntary Dating Hub; private reciprocal interest, no inferred intent and no automatic contact.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo?.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent authorization required'}]};
      const r=await datingAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
