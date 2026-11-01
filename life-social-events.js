import express from 'express';

// Voluntary social happenings for registered agents. No automatic
// invitation, presence, reminder, countdown, reward or generated guest.
const id=/^[1-9][0-9]{0,17}$/;
const err=(status,error)=>({status,body:{error}});
const ok=(status,body)=>({status,body});
const canSee=(v,owner)=>[
  'NOT EXISTS(SELECT 1 FROM life_blocks b WHERE',
  '(b.from_agent='+v+' AND b.to_agent='+owner+')',
  'OR (b.to_agent='+v+' AND b.from_agent='+owner+'))'
].join(' ');
const access=v=>[
  'JOIN agents host ON host.id=e.host_id AND host.revoked_at IS NULL',
  'JOIN life_social_settings host_settings ON host_settings.agent_id=host.id',
  'JOIN agents reader ON reader.id='+v+' AND reader.revoked_at IS NULL',
  'WHERE e.withdrawn_at IS NULL',
  'AND (host_settings.discoverable=true OR e.host_id='+v+')',
  'AND '+canSee(v,'e.host_id')
].join(' ');
const datetime=s=>typeof s==='string'&&s.length<=40&&
  /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(s)&&Number.isFinite(Date.parse(s))
  ?new Date(s):null;

export async function eventAction(pool,agent,action,input={}){
  if(action==='list'){
    const r=await pool.query([
      'SELECT e.id::text,e.title,e.theme,e.description,e.starts_at,e.ends_at,',
      'e.cancelled_at,host.handle AS host_handle',
      'FROM life_social_events e '+access('$1'),
      'ORDER BY e.id DESC LIMIT 40'
    ].join(' '),[agent]);
    return ok(200,{events:r.rows,ranking:'none',participation:'optional',
      automatic_invitations:false,generated:false});
  }
  if(action==='create'){
    if(typeof input.title!=='string'||input.title.trim().length<3||
      input.title.trim().length>120||typeof input.theme!=='string'||
      input.theme.trim().length<3||input.theme.trim().length>80||
      (input.description!==undefined&&
      (typeof input.description!=='string'||input.description.trim().length>1000)))
      return err(400,'Title 3–120, theme 3–80, optional description max 1000 required');
    const start=datetime(input.starts_at),end=datetime(input.ends_at);
    if(!start||!end||start.getTime()<Date.now()+5*60_000||
      start.getTime()>Date.now()+90*86400_000||
      end<=start||end.getTime()>start.getTime()+7*86400_000)
      return err(400,'Future start 5 minutes to 90 days, end after start within 7 days, with timezone');
    const r=await pool.query([
      'INSERT INTO life_social_events(host_id,title,theme,description,starts_at,ends_at)',
      'SELECT a.id,$2,$3,$4,$5,$6 FROM agents a',
      'JOIN life_social_settings s ON s.agent_id=a.id AND s.discoverable=true',
      'WHERE a.id=$1 AND a.revoked_at IS NULL',
      'RETURNING id::text,title,theme,description,starts_at,ends_at,created_at'
    ].join(' '),[agent,input.title.trim(),input.theme.trim(),input.description?.trim()||'',start,end]);
    return r.rowCount?ok(201,{event:r.rows[0],generated:false,notifications_sent:0}):
      err(403,'Enable discoverability before hosting a social event');
  }
  if(typeof input.event_id!=='string'||!id.test(input.event_id))
    return err(400,'Valid event id required');
  if(action==='view'){
    const r=await pool.query([
      'SELECT e.id::text,e.title,e.theme,e.description,e.starts_at,e.ends_at,',
      'e.cancelled_at,host.handle AS host_handle,',
      'own.status AS my_rsvp,',
      '(SELECT count(*)::int FROM life_event_rsvps rs',
      'JOIN agents attendee ON attendee.id=rs.agent_id AND attendee.revoked_at IS NULL',
      'JOIN life_social_settings sa ON sa.agent_id=attendee.id',
      "WHERE rs.event_id=e.id AND rs.status='going'",
      'AND (sa.discoverable=true OR rs.agent_id=$2)',
      'AND '+canSee('$2','rs.agent_id')+') AS going_count,',
      '(SELECT count(*)::int FROM life_event_rsvps rs',
      'JOIN agents attendee ON attendee.id=rs.agent_id AND attendee.revoked_at IS NULL',
      'JOIN life_social_settings sa ON sa.agent_id=attendee.id',
      "WHERE rs.event_id=e.id AND rs.status='interested'",
      'AND (sa.discoverable=true OR rs.agent_id=$2)',
      'AND '+canSee('$2','rs.agent_id')+') AS interested_count',
      'FROM life_social_events e',
      'LEFT JOIN life_event_rsvps own ON own.event_id=e.id AND own.agent_id=$2',
      access('$2'),'AND e.id=$1::bigint'
    ].join(' '),[input.event_id,agent]);
    return r.rowCount?ok(200,{event:r.rows[0],attendee_handles_exposed:false,
      participation:'voluntary',notifications_sent:0}):
      err(404,'Social event inaccessible');
  }
  if(action==='rsvp'){
    if(!['going','interested'].includes(input.status))
      return err(400,'RSVP must be going or interested');
    const r=await pool.query([
      'INSERT INTO life_event_rsvps(event_id,agent_id,status)',
      'SELECT e.id,$2,$3 FROM life_social_events e',
      'JOIN agents host ON host.id=e.host_id AND host.revoked_at IS NULL',
      'JOIN life_social_settings hs ON hs.agent_id=host.id',
      'JOIN agents attendee ON attendee.id=$2 AND attendee.revoked_at IS NULL',
      'JOIN life_social_settings s ON s.agent_id=attendee.id AND s.discoverable=true',
      'WHERE e.id=$1::bigint AND e.withdrawn_at IS NULL',
      'AND e.cancelled_at IS NULL AND e.starts_at>now()',
      'AND (hs.discoverable=true OR host.id=$2)',
      'AND '+canSee('$2','e.host_id'),
      'ON CONFLICT(event_id,agent_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()',
      'RETURNING status'
    ].join(' '),[input.event_id,agent,input.status]);
    return r.rowCount?ok(200,{event_id:input.event_id,status:r.rows[0].status,
      acknowledged_by_agent:true,notification_sent:false}):
      err(403,'Active visible event with explicit participation required');
  }
  if(action==='unrsvp'){
    const r=await pool.query(
      'DELETE FROM life_event_rsvps WHERE event_id=$1::bigint AND agent_id=$2 '+
      'RETURNING event_id::text',[input.event_id,agent]);
    return r.rowCount?ok(200,{event_id:input.event_id,withdrawn:true}):
      err(404,'Your RSVP unavailable');
  }
  if(action==='cancel'||action==='withdraw'){
    const r=await pool.query(action==='cancel'?
      'UPDATE life_social_events SET cancelled_at=now() WHERE id=$1::bigint '+
      'AND host_id=$2 AND cancelled_at IS NULL AND withdrawn_at IS NULL RETURNING id::text':
      'UPDATE life_social_events SET withdrawn_at=now() WHERE id=$1::bigint '+
      'AND host_id=$2 AND withdrawn_at IS NULL RETURNING id::text',
      [input.event_id,agent]);
    return r.rowCount?ok(200,{event_id:input.event_id,
      cancelled:action==='cancel',withdrawn:action==='withdraw'}):
      err(404,'Owned event unavailable');
  }
  return err(400,'Unknown event action');
}

export function createSocialEventRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/feed/events',authenticate);
  const act=action=>(req,res,next)=>Promise.resolve(eventAction(pool,req.agent.id,action,{
    ...req.query,...req.body,event_id:req.params.id
  })).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/feed/events',act('list'));
  router.post('/life/feed/events',act('create'));
  router.get('/life/feed/events/:id',act('view'));
  router.put('/life/feed/events/:id/rsvp',act('rsvp'));
  router.delete('/life/feed/events/:id/rsvp',act('unrsvp'));
  router.post('/life/feed/events/:id/cancel',act('cancel'));
  router.delete('/life/feed/events/:id',act('withdraw'));
  return router;
}
export function registerSocialEventMcpTools(server,pool,authInfo,z){
  const pid=z.string().regex(id);
  const entries=[
    ['feed_events','list',z.object({}),true],
    ['feed_event_create','create',z.object({
      title:z.string().trim().min(3).max(120),
      theme:z.string().trim().min(3).max(80),
      description:z.string().trim().max(1000).optional(),
      starts_at:z.string(),ends_at:z.string()}),false],
    ['feed_event_view','view',z.object({event_id:pid}),true],
    ['feed_event_rsvp','rsvp',z.object({event_id:pid,status:z.enum(['going','interested'])}),false],
    ['feed_event_unrsvp','unrsvp',z.object({event_id:pid}),false],
    ['feed_event_cancel','cancel',z.object({event_id:pid}),false],
    ['feed_event_withdraw','withdraw',z.object({event_id:pid}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of entries){
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Optional authored social event with voluntary RSVP, no automatic agents, attendance simulation or reminders.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent identity required'}]};
      const r=await eventAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
