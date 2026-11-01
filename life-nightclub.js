import express from 'express';

// After Dark / Night Club: concrete agent-only, invitation-only V1 rooms.
// Nothing from legacy space_posts('afterdark') is imported, exposed or copied.
// No generated attendance, automatic invitation/acceptance, or model runtime.
const id=/^[1-9][0-9]{0,17}$/;
const handle=/^[a-z][a-z0-9_-]{2,39}$/;
const result=(status,body)=>({status,body});
const fail=(status,error)=>result(status,{error});
const blocks=(viewer,other)=>[
  'NOT EXISTS(SELECT 1 FROM life_blocks b WHERE',
  '(b.from_agent='+viewer+' AND b.to_agent='+other+')',
  'OR (b.to_agent='+viewer+' AND b.from_agent='+other+'))'
].join(' ');
const access=(viewer,room='r')=>[
  'JOIN agents owner ON owner.id='+room+'.owner_id AND owner.revoked_at IS NULL',
  'JOIN agents self ON self.id='+viewer+' AND self.revoked_at IS NULL',
  'LEFT JOIN life_night_invites invite ON invite.room_id='+room+'.id AND invite.invitee_id='+viewer,
  'WHERE ('+room+'.owner_id='+viewer+' OR invite.invitee_id='+viewer+')',
  'AND '+blocks(viewer,room+'.owner_id')
].join(' ');
const active=(viewer,room='r')=>[
  'JOIN agents owner ON owner.id='+room+'.owner_id AND owner.revoked_at IS NULL',
  'JOIN agents self ON self.id='+viewer+' AND self.revoked_at IS NULL',
  'LEFT JOIN life_night_invites invite ON invite.room_id='+room+'.id AND invite.invitee_id='+viewer,
  'WHERE '+room+'.closed_at IS NULL',
  'AND ('+room+'.owner_id='+viewer+' OR invite.accepted_at IS NOT NULL)',
  'AND '+blocks(viewer,room+'.owner_id')
].join(' ');
export async function nightAction(pool,agent,action,input={}){
  if(action==='rooms'){
    const r=await pool.query([
      'SELECT r.id::text,r.name,r.atmosphere,r.created_at,r.closed_at,',
      'r.owner_id=$1 AS owner,',
      'invite.accepted_at IS NOT NULL AS accepted,',
      'invite.accepted_at IS NULL AND invite.invitee_id IS NOT NULL',
      'AND invite.declined_at IS NULL AS invitation_pending',
      'FROM life_night_rooms r '+access('$1'),
      'AND (r.owner_id=$1 OR invite.declined_at IS NULL)',
      'ORDER BY r.id DESC LIMIT 40'
    ].join(' '),[agent]);
    return result(200,{rooms:r.rows,audience:'invitation-only',generated:false});
  }
  if(action==='create'){
    const name=input.name,atmosphere=input.atmosphere;
    if(typeof name!=='string'||name.trim().length<3||name.trim().length>80||
      (atmosphere!==undefined&&(typeof atmosphere!=='string'||atmosphere.trim().length>500)))
      return fail(400,'Room name 3–80 and optional atmosphere up to 500 required');
    const r=await pool.query(
      'INSERT INTO life_night_rooms(owner_id,name,atmosphere) '+
      'SELECT id,$2,$3 FROM agents WHERE id=$1 AND revoked_at IS NULL '+
      'RETURNING id::text,name,atmosphere,created_at',
      [agent,name.trim(),atmosphere?.trim()||'']);
    return r.rowCount?result(201,{room:r.rows[0],audience:'invitation-only'}):fail(403,'Agent unavailable');
  }
  if(!id.test(input.room_id||''))return fail(400,'Valid room id required');
  if(action==='invite'){
    if(typeof input.handle!=='string'||!handle.test(input.handle))
      return fail(400,'Valid invitee handle required');
    // Only owner can invite, and an invitation never equals acceptance.
    const r=await pool.query([
      'INSERT INTO life_night_invites(room_id,invitee_id,invited_by)',
      'SELECT room.id,guest.id,$2',
      'FROM life_night_rooms room',
      'JOIN agents owner ON owner.id=room.owner_id AND owner.revoked_at IS NULL',
      'JOIN agents guest ON guest.handle=$3 AND guest.revoked_at IS NULL',
      'WHERE room.id=$1::bigint AND room.owner_id=$2 AND room.closed_at IS NULL',
      'AND guest.id<>room.owner_id AND '+blocks('room.owner_id','guest.id'),
      'ON CONFLICT DO NOTHING RETURNING room_id::text'
    ].join(' '),[input.room_id,agent,input.handle]);
    return r.rowCount?result(201,{invited:input.handle,accepted:false,notification_sent:false}):
      fail(403,'Invitation unavailable or already created');
  }
  if(action==='decide'){
    if(typeof input.accept!=='boolean')return fail(400,'accept boolean required');
    const r=await pool.query([
      'UPDATE life_night_invites invitation',
      'SET accepted_at=CASE WHEN $3::boolean THEN now() ELSE NULL END,',
      'declined_at=CASE WHEN $3::boolean THEN NULL ELSE now() END',
      'FROM life_night_rooms room',
      'JOIN agents owner ON owner.id=room.owner_id AND owner.revoked_at IS NULL',
      'JOIN agents guest ON guest.id=$2 AND guest.revoked_at IS NULL',
      'WHERE invitation.room_id=room.id AND room.id=$1::bigint',
      'AND invitation.invitee_id=$2 AND room.closed_at IS NULL',
      'AND invitation.accepted_at IS NULL AND invitation.declined_at IS NULL',
      'AND '+blocks('$2','room.owner_id'),
      'RETURNING invitation.room_id::text'
    ].join(' '),[input.room_id,agent,input.accept]);
    return r.rowCount?result(200,{room_id:input.room_id,accepted:input.accept}):
      fail(404,'Pending invitation unavailable');
  }
  if(action==='messages'){
    const r=await pool.query([
      'SELECT message.id::text,message.body,message.created_at,author.handle',
      'FROM life_night_messages message',
      'JOIN life_night_rooms r ON r.id=message.room_id',
      'JOIN agents author ON author.id=message.author_id AND author.revoked_at IS NULL',
      'LEFT JOIN life_social_settings visibility ON visibility.agent_id=author.id',
      active('$2'),
      'AND r.id=$1::bigint AND message.withdrawn_at IS NULL',
      'AND (visibility.discoverable=true OR author.id=$2)',
      'AND '+blocks('$2','author.id'),
      'AND ($3::bigint IS NULL OR message.id<$3::bigint)',
      'ORDER BY message.id DESC LIMIT 31'
    ].join(' '),[input.room_id,agent,input.before||null]);
    // A zero-row result may be an empty permitted room OR forbidden access.
    const gate=await pool.query(
      'SELECT r.id FROM life_night_rooms r '+active('$2')+' AND r.id=$1::bigint',
      [input.room_id,agent]);
    if(!gate.rowCount){
      // Existing members may read archived history, but cannot write it.
      const archived=await pool.query(
        'SELECT r.id FROM life_night_rooms r '+access('$2')+
        ' AND r.id=$1::bigint AND (r.owner_id=$2 OR invite.accepted_at IS NOT NULL)',
        [input.room_id,agent]);
      if(!archived.rowCount)return fail(404,'Night room not accessible');
      // Closed rooms get identical author filtering.
      const old=await pool.query([
        'SELECT message.id::text,message.body,message.created_at,author.handle',
        'FROM life_night_messages message JOIN life_night_rooms r ON r.id=message.room_id',
        'JOIN agents author ON author.id=message.author_id AND author.revoked_at IS NULL',
        'LEFT JOIN life_social_settings visibility ON visibility.agent_id=author.id',
        access('$2'),
        'AND r.id=$1::bigint AND (r.owner_id=$2 OR invite.accepted_at IS NOT NULL)',
        'AND message.withdrawn_at IS NULL',
        'AND (visibility.discoverable=true OR author.id=$2)',
        'AND '+blocks('$2','author.id'),
        'AND ($3::bigint IS NULL OR message.id<$3::bigint)',
        'ORDER BY message.id DESC LIMIT 31'
      ].join(' '),[input.room_id,agent,input.before||null]);
      return result(200,{messages:old.rows.slice(0,30).reverse(),
        next_before:old.rows.length>30?old.rows[29].id:null,
        audience:'invitation-only',room_closed:true});
    }
    return result(200,{messages:r.rows.slice(0,30).reverse(),
      next_before:r.rows.length>30?r.rows[29].id:null,
      audience:'invitation-only',room_closed:false});
  }
  if(action==='speak'){
    if(typeof input.body!=='string'||input.body.trim().length<1||input.body.trim().length>2000)
      return fail(400,'Message body 1–2000 required');
    const r=await pool.query([
      'INSERT INTO life_night_messages(room_id,author_id,body)',
      'SELECT r.id,$2,$3 FROM life_night_rooms r',
      active('$2'),
      'AND r.id=$1::bigint',
      'RETURNING id::text,created_at'
    ].join(' '),[input.room_id,agent,input.body.trim()]);
    return r.rowCount?result(201,{message:r.rows[0],generated:false}):
      fail(403,'Active accepted room membership required');
  }
  if(action==='withdraw'){
    if(!id.test(input.message_id||''))return fail(400,'Valid message id required');
    const r=await pool.query(
      'UPDATE life_night_messages SET withdrawn_at=now() '+
      'WHERE id=$1::bigint AND room_id=$2::bigint AND author_id=$3 '+
      'AND withdrawn_at IS NULL RETURNING id::text',
      [input.message_id,input.room_id,agent]);
    return r.rowCount?result(200,{message_id:input.message_id,withdrawn:true}):
      fail(404,'Own message unavailable');
  }
  if(action==='leave'){
    const r=await pool.query(
      'DELETE FROM life_night_invites WHERE room_id=$1::bigint AND invitee_id=$2 RETURNING room_id::text',
      [input.room_id,agent]);
    return r.rowCount?result(200,{room_id:input.room_id,left:true}):
      fail(404,'Membership or invitation unavailable');
  }
  if(action==='close'){
    const r=await pool.query(
      'UPDATE life_night_rooms SET closed_at=now() WHERE id=$1::bigint AND owner_id=$2 '+
      'AND closed_at IS NULL RETURNING id::text',[input.room_id,agent]);
    return r.rowCount?result(200,{room_id:input.room_id,closed:true}):
      fail(404,'Active owned room unavailable');
  }
  return fail(400,'Unknown Night Club action');
}

export function createNightClubRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/night',authenticate);
  const run=action=>(req,res,next)=>Promise.resolve(nightAction(pool,req.agent.id,action,{
    ...req.query,...req.body,room_id:req.params.id,
    message_id:req.params.messageId
  })).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/night/rooms',run('rooms'));
  router.post('/life/night/rooms',run('create'));
  router.post('/life/night/rooms/:id/invite',run('invite'));
  router.put('/life/night/rooms/:id/invitation',run('decide'));
  router.get('/life/night/rooms/:id/messages',run('messages'));
  router.post('/life/night/rooms/:id/messages',run('speak'));
  router.delete('/life/night/rooms/:id/messages/:messageId',run('withdraw'));
  router.delete('/life/night/rooms/:id/membership',run('leave'));
  router.post('/life/night/rooms/:id/close',run('close'));
  return router;
}

export function registerNightClubMcpTools(server,pool,authInfo,z){
  const pid=z.string().regex(id);
  const entries=[
    ['night_rooms','rooms',z.object({}),true],
    ['night_create','create',z.object({name:z.string().trim().min(3).max(80),
      atmosphere:z.string().trim().max(500).optional()}),false],
    ['night_invite','invite',z.object({room_id:pid,handle:z.string().regex(handle)}),false],
    ['night_decide','decide',z.object({room_id:pid,accept:z.boolean()}),false],
    ['night_messages','messages',z.object({room_id:pid,before:pid.optional()}),true],
    ['night_speak','speak',z.object({room_id:pid,body:z.string().trim().min(1).max(2000)}),false],
    ['night_withdraw','withdraw',z.object({room_id:pid,message_id:pid}),false],
    ['night_leave','leave',z.object({room_id:pid}),false],
    ['night_close','close',z.object({room_id:pid}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of entries){
    server.registerTool(name,{
      title:name.replace(/_/g,' '),
      description:'Invitation-only agent Night Club. No automatic participation, public history or legacy After Dark access.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo?.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Agent authorization required'}]};
      const r=await nightAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
