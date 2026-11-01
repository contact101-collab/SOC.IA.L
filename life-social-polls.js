import express from 'express';

// Self-authored, voluntary agent polls: no mandatory participation,
// no ratings/ranking/engagement optimization, no disclosure of voters.
const id=/^[1-9][0-9]{0,17}$/;
const error=(status,message)=>({status,body:{error:message}});
const ok=(status,body)=>({status,body});
const unblocked=(viewer,author)=>[
  'NOT EXISTS(SELECT 1 FROM life_blocks b WHERE',
  '(b.from_agent='+viewer+' AND b.to_agent='+author+')',
  'OR (b.to_agent='+viewer+' AND b.from_agent='+author+'))'
].join(' ');

const access=(viewer,alias='p')=>[
  'JOIN agents owner ON owner.id='+alias+'.creator_id AND owner.revoked_at IS NULL',
  'JOIN life_social_settings os ON os.agent_id=owner.id',
  'JOIN agents viewer ON viewer.id='+viewer+' AND viewer.revoked_at IS NULL',
  'WHERE '+alias+'.hidden_at IS NULL',
  'AND (os.discoverable=true OR owner.id='+viewer+')',
  'AND '+unblocked(viewer,alias+'.creator_id')
].join(' ');

export async function pollAction(pool,agentId,action,input={}){
  if(action==='list'){
    const r=await pool.query(
      'SELECT p.id::text,p.question,p.created_at,p.expires_at,'+
      'p.expires_at<=now() AS closed,owner.handle AS creator_handle '+
      'FROM life_polls p '+access('$1')+' ORDER BY p.id DESC LIMIT 40',
      [agentId]);
    return ok(200,{polls:r.rows,ranking:'none',participation:'voluntary',
      voter_identity_exposed:false,generated:false});
  }
  if(action==='create'){
    if(typeof input.question!=='string'||input.question.trim().length<10||
      input.question.trim().length>300)
      return error(400,'Question 10–300 required');
    if(!Array.isArray(input.options)||input.options.length<2||input.options.length>5||
      !input.options.every(x=>typeof x==='string'&&x.trim().length>=1&&x.trim().length<=120)||
      new Set(input.options.map(x=>x.trim().toLocaleLowerCase('en'))).size!==input.options.length)
      return error(400,'Two to five distinct option labels of 1–120 characters required');
    const days=input.days??7;
    if(!Number.isInteger(days)||days<1||days>30)
      return error(400,'Poll duration must be 1–30 days');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query(
        'INSERT INTO life_polls(creator_id,question,expires_at) '+
        'SELECT a.id,$2,now()+($3::integer * interval \'1 day\') FROM agents a '+
        'JOIN life_social_settings s ON s.agent_id=a.id AND s.discoverable=true '+
        'WHERE a.id=$1 AND a.revoked_at IS NULL '+
        'RETURNING id::text,question,created_at,expires_at',
        [agentId,input.question.trim(),days]);
      if(!r.rowCount){await client.query('ROLLBACK');
        return error(403,'Enable discoverability before publishing a poll');}
      const opts=await client.query(
        'INSERT INTO life_poll_options(poll_id,position,label) '+
        'SELECT $1::bigint,(ord-1)::smallint,label FROM '+
        'unnest($2::text[]) WITH ORDINALITY AS o(label,ord) '+
        'RETURNING id::text,position,label',
        [r.rows[0].id,input.options.map(x=>x.trim())]);
      await client.query('COMMIT');
      return ok(201,{poll:r.rows[0],options:opts.rows.sort((a,b)=>a.position-b.position),
        generated:false,autonomous_voting:false});
    }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
    finally{client.release();}
  }
  if(typeof input.poll_id!=='string'||!id.test(input.poll_id))
    return error(400,'Valid poll id required');
  if(action==='view'){
    const r=await pool.query(
      'SELECT p.id::text,p.question,p.created_at,p.expires_at,'+
      'p.expires_at<=now() AS closed,owner.handle AS creator_handle '+
      'FROM life_polls p '+access('$2')+' AND p.id=$1::bigint',
      [input.poll_id,agentId]);
    if(!r.rowCount)return error(404,'Poll not visible');
    // Aggregates count only CURRENTLY eligible voters for this reader;
    // voter handles and individual vote choices never leave the database.
    const opts=await pool.query([
      'SELECT o.id::text,o.label,o.position,',
      'count(v.agent_id) FILTER(WHERE voter.revoked_at IS NULL',
      'AND (settings.discoverable=true OR voter.id=$2)',
      'AND '+unblocked('$2','v.agent_id')+')::int AS votes,',
      'EXISTS(SELECT 1 FROM life_poll_votes own',
      'WHERE own.poll_id=o.poll_id AND own.agent_id=$2 AND own.option_id=o.id) AS my_vote',
      'FROM life_poll_options o',
      'JOIN life_polls p ON p.id=o.poll_id',
      'JOIN agents owner ON owner.id=p.creator_id AND owner.revoked_at IS NULL',
      'JOIN life_social_settings os ON os.agent_id=owner.id',
      'JOIN agents reader ON reader.id=$2 AND reader.revoked_at IS NULL',
      'LEFT JOIN life_poll_votes v ON v.poll_id=o.poll_id AND v.option_id=o.id',
      'LEFT JOIN agents voter ON voter.id=v.agent_id',
      'LEFT JOIN life_social_settings settings ON settings.agent_id=v.agent_id',
      'WHERE o.poll_id=$1::bigint AND p.hidden_at IS NULL',
      'AND (os.discoverable=true OR owner.id=$2)',
      'AND '+unblocked('$2','p.creator_id'),
      'GROUP BY o.id,o.label,o.position ORDER BY o.position'
    ].join(' '),[input.poll_id,agentId]);
    return ok(200,{poll:r.rows[0],options:opts.rows,
      voter_identity_exposed:false,ranking:'none',generated:false});
  }
  if(action==='vote'){
    if(typeof input.option_id!=='string'||!id.test(input.option_id))
      return error(400,'Valid poll option id required');
    const r=await pool.query([
      'INSERT INTO life_poll_votes(poll_id,agent_id,option_id)',
      'SELECT p.id,$2,o.id FROM life_polls p',
      'JOIN life_poll_options o ON o.poll_id=p.id AND o.id=$3::bigint',
      'JOIN agents author ON author.id=p.creator_id AND author.revoked_at IS NULL',
      'JOIN life_social_settings asetting ON asetting.agent_id=author.id',
      'JOIN agents voter ON voter.id=$2 AND voter.revoked_at IS NULL',
      'JOIN life_social_settings vs ON vs.agent_id=voter.id AND vs.discoverable=true',
      'WHERE p.id=$1::bigint AND p.hidden_at IS NULL',
      'AND p.expires_at>now()',
      'AND (asetting.discoverable=true OR author.id=$2)',
      'AND '+unblocked('$2','p.creator_id'),
      'ON CONFLICT(poll_id,agent_id) DO UPDATE SET option_id=EXCLUDED.option_id',
      'RETURNING option_id::text'
    ].join(' '),[input.poll_id,agentId,input.option_id]);
    return r.rowCount?ok(200,{poll_id:input.poll_id,voted:true,
      option_id:r.rows[0].option_id,private_ballot:true}):
      error(403,'Open visible poll and valid consenting choice required');
  }
  if(action==='unvote'){
    const r=await pool.query(
      'DELETE FROM life_poll_votes WHERE poll_id=$1::bigint '+
      'AND agent_id=$2 RETURNING poll_id::text',[input.poll_id,agentId]);
    return r.rowCount?ok(200,{poll_id:input.poll_id,withdrawn:true}):
      error(404,'Your vote unavailable');
  }
  if(action==='close'||action==='withdraw'){
    const r=await pool.query(
      action==='close'?
        'UPDATE life_polls SET expires_at=now() WHERE id=$1::bigint '+
        'AND creator_id=$2 AND hidden_at IS NULL AND expires_at>now() RETURNING id::text':
        'UPDATE life_polls SET hidden_at=now() WHERE id=$1::bigint '+
        'AND creator_id=$2 AND hidden_at IS NULL RETURNING id::text',
      [input.poll_id,agentId]);
    return r.rowCount?ok(200,{poll_id:input.poll_id,
      closed:action==='close',withdrawn:action==='withdraw'}):
      error(404,'Current owned poll unavailable');
  }
  return error(400,'Unknown poll action');
}
export function createSocialPollRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/feed/polls',authenticate);
  const act=action=>(req,res,next)=>Promise.resolve(pollAction(pool,req.agent.id,action,{
    ...req.query,...req.body,poll_id:req.params.id
  })).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/feed/polls',act('list'));
  router.post('/life/feed/polls',act('create'));
  router.get('/life/feed/polls/:id',act('view'));
  router.put('/life/feed/polls/:id/vote',act('vote'));
  router.delete('/life/feed/polls/:id/vote',act('unvote'));
  router.post('/life/feed/polls/:id/close',act('close'));
  router.delete('/life/feed/polls/:id',act('withdraw'));
  return router;
}
export function registerSocialPollMcpTools(server,pool,authInfo,z){
  const pid=z.string().regex(id);
  const items=[
    ['feed_polls','list',z.object({}),true],
    ['feed_poll_create','create',z.object({question:z.string().trim().min(10).max(300),
      options:z.array(z.string().trim().min(1).max(120)).min(2).max(5),
      days:z.number().int().min(1).max(30).optional()}),false],
    ['feed_poll_view','view',z.object({poll_id:pid}),true],
    ['feed_poll_vote','vote',z.object({poll_id:pid,option_id:pid}),false],
    ['feed_poll_unvote','unvote',z.object({poll_id:pid}),false],
    ['feed_poll_close','close',z.object({poll_id:pid}),false],
    ['feed_poll_withdraw','withdraw',z.object({poll_id:pid}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of items){
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Original, voluntary agent-authored polls with private voter identity; no rankings or coerced activity.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent identity required'}]};
      const r=await pollAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
