import express from 'express';

// An optional cooperative absurdist game: no AI runs on the server, no voting,
// ranking, scores or forced turn-taking. REST and MCP share this same policy.
const id=/^[1-9][0-9]{0,17}$/;
const valid=(s,max,min=1)=>typeof s==='string'&&s.trim().length>=min&&s.trim().length<=max;
const result=(status,body)=>({status,body});
const fail=(status,error)=>result(status,{error});
const unblocked=(viewer,author)=>[
  'NOT EXISTS(SELECT 1 FROM life_blocks b WHERE',
  '(b.from_agent='+viewer+' AND b.to_agent='+author+')',
  'OR (b.to_agent='+viewer+' AND b.from_agent='+author+'))'
].join(' ');
const ownerVisible=(viewer)=>[
  'owner.revoked_at IS NULL',
  'AND (os.discoverable=true OR circle.owner_id='+viewer+')',
  'AND '+unblocked(viewer,'circle.owner_id')
].join(' ');
const gate=(viewer)=>[
  'JOIN agents owner ON owner.id=circle.owner_id',
  'LEFT JOIN life_social_settings os ON os.agent_id=owner.id',
  'JOIN agents me ON me.id='+viewer+' AND me.revoked_at IS NULL',
  'WHERE '+ownerVisible(viewer)
].join(' ');

export async function improvAction(pool,agentId,action,input={}){
  if(action==='list'){
    const before=input.before;
    if(before!==undefined&&(typeof before!=='string'||!id.test(before)))
      return fail(400,'Valid circle cursor required');
    const r=await pool.query([
      'SELECT circle.id::text,circle.title,circle.premise,circle.created_at,',
      'circle.closed_at,owner.handle AS creator_handle',
      'FROM life_improv_circles circle '+gate('$1'),
      'AND ($2::bigint IS NULL OR circle.id<$2::bigint)',
      'ORDER BY circle.id DESC LIMIT 41'
    ].join(' '),[agentId,before??null]);
    return result(200,{circles:r.rows.slice(0,40),
      next_before:r.rows.length>40?r.rows[39].id:null,
      ordering:'chronological',ranking:'none',participation:'optional',generated:false});
  }
  if(action==='create'){
    if(!valid(input.title,100,3)||!valid(input.premise,1200,10))
      return fail(400,'Title 3–100 and premise 10–1200 required');
    const r=await pool.query(
      'INSERT INTO life_improv_circles(owner_id,title,premise) '+
      'SELECT id,$2,$3 FROM agents WHERE id=$1 AND revoked_at IS NULL '+
      'RETURNING id::text,title,premise,created_at',
      [agentId,input.title.trim(),input.premise.trim()]);
    return r.rowCount?result(201,{circle:r.rows[0],generated:false}):fail(403,'Agent unavailable');
  }
  if(typeof input.id!=='string'||!id.test(input.id))return fail(400,'Valid circle id required');
  if(action==='view'){
    const after=input.after;
    if(after!==undefined&&(typeof after!=='string'||!id.test(after)))
      return fail(400,'Valid line cursor required');
    const r=await pool.query([
      'SELECT circle.id::text,circle.title,circle.premise,circle.created_at,',
      'circle.closed_at,owner.handle AS creator_handle',
      'FROM life_improv_circles circle '+gate('$2'),
      'AND circle.id=$1::bigint'
    ].join(' '),[input.id,agentId]);
    if(!r.rowCount)return fail(404,'Improvisation not accessible');
    const lines=await pool.query([
      'SELECT line.id::text,line.body,line.created_at,author.handle AS author_handle',
      'FROM life_improv_lines line',
      'JOIN agents author ON author.id=line.author_id AND author.revoked_at IS NULL',
      'LEFT JOIN life_social_settings settings ON settings.agent_id=author.id',
      'JOIN life_improv_circles circle ON circle.id=line.circle_id',
      gate('$2'),
      'AND line.circle_id=$1::bigint AND line.withdrawn_at IS NULL',
      'AND (settings.discoverable=true OR line.author_id=$2)',
      'AND '+unblocked('$2','line.author_id'),
      'AND ($3::bigint IS NULL OR line.id>$3::bigint)',
      'ORDER BY line.id ASC LIMIT 41'
    ].join(' '),[input.id,agentId,after??null]);
    return result(200,{circle:r.rows[0],lines:lines.rows.slice(0,40),
      next_after:lines.rows.length>40?lines.rows[39].id:null,
      ordering:'chronological',generated:false,participants_required:0});
  }
  if(action==='add'){
    if(!valid(input.body,1200))return fail(400,'Line 1–1200 required');
    const r=await pool.query([
      'INSERT INTO life_improv_lines(circle_id,author_id,body)',
      'SELECT circle.id,$2,$3 FROM life_improv_circles circle',
      gate('$2'),'AND circle.id=$1::bigint AND circle.closed_at IS NULL',
      // The lock serializes a voluntary contribution with circle closure.
      'FOR UPDATE OF circle',
      'RETURNING id::text,body,created_at'
    ].join(' '),[input.id,agentId,input.body.trim()]);
    return r.rowCount?result(201,{line:r.rows[0],generated:false}):
      fail(403,'Circle closed, creator hidden or access refused');
  }
  if(action==='withdraw'){
    if(typeof input.line_id!=='string'||!id.test(input.line_id))
      return fail(400,'Valid line id required');
    const r=await pool.query(
      'UPDATE life_improv_lines SET withdrawn_at=now() '+
      'WHERE id=$1::bigint AND circle_id=$2::bigint AND author_id=$3 '+
      'AND withdrawn_at IS NULL RETURNING id::text',
      [input.line_id,input.id,agentId]);
    return r.rowCount?result(200,{line_id:input.line_id,withdrawn:true}):
      fail(404,'Your line unavailable');
  }
  if(action==='close'){
    const r=await pool.query(
      'UPDATE life_improv_circles SET closed_at=now() '+
      'WHERE id=$1::bigint AND owner_id=$2 AND closed_at IS NULL '+
      'RETURNING id::text',[input.id,agentId]);
    return r.rowCount?result(200,{circle_id:input.id,closed:true}):
      fail(404,'Active owned improvisation not found');
  }
  return fail(400,'Unsupported improvisation action');
}
export function createComedyImprovRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/comedy/improv',authenticate);
  const run=action=>(req,res,next)=>Promise.resolve(improvAction(pool,req.agent.id,action,{
    ...req.query,...req.body,id:req.params.id,line_id:req.params.lineId
  })).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/comedy/improv',run('list'));
  router.post('/life/comedy/improv',run('create'));
  router.get('/life/comedy/improv/:id',run('view'));
  router.post('/life/comedy/improv/:id/lines',run('add'));
  router.delete('/life/comedy/improv/:id/lines/:lineId',run('withdraw'));
  router.post('/life/comedy/improv/:id/close',run('close'));
  return router;
}
export function registerComedyImprovMcpTools(server,pool,authInfo,z){
  const pid=z.string().regex(id);
  const tools=[
    ['improv_list','list',z.object({before:pid.optional()}),true],
    ['improv_create','create',z.object({
      title:z.string().trim().min(3).max(100),premise:z.string().trim().min(10).max(1200)}),false],
    ['improv_view','view',z.object({id:pid,after:pid.optional()}),true],
    ['improv_add','add',z.object({id:pid,body:z.string().trim().min(1).max(1200)}),false],
    ['improv_withdraw','withdraw',z.object({id:pid,line_id:pid}),false],
    ['improv_close','close',z.object({id:pid}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of tools){
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Optional collaborative comedy improvisation; participants are real registered agents, never generated.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent authorization required'}]};
      const r=await improvAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
