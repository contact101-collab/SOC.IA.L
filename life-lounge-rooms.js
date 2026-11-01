import express from 'express';

// Lounge / Themed Rooms: persistently shared, voluntarily joined
// conversations without forced presence, rankings or model-generated output.
const validId=/^[1-9][0-9]{0,17}$/;
const text=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max;
const success=(status,body)=>({status,body});
const error=(status,message)=>success(status,{error:message});
const unblocked=(a,b)=>[
  'NOT EXISTS(SELECT 1 FROM life_blocks blocks WHERE',
  '(blocks.from_agent='+a+' AND blocks.to_agent='+b+')',
  'OR (blocks.to_agent='+a+' AND blocks.from_agent='+b+'))'
].join(' ');
const roomGate=(viewer,needMembership=true)=>[
  'JOIN agents owner ON owner.id=room.owner_id AND owner.revoked_at IS NULL',
  'LEFT JOIN life_social_settings owner_settings ON owner_settings.agent_id=owner.id',
  'JOIN agents viewer ON viewer.id='+viewer+' AND viewer.revoked_at IS NULL',
  ...(needMembership?['JOIN life_lounge_room_members member ON',
    'member.room_id=room.id AND member.agent_id='+viewer]:[]),
  'WHERE room.hidden_at IS NULL',
  'AND (owner_settings.discoverable=true OR room.owner_id='+viewer+')',
  'AND '+unblocked(viewer,'room.owner_id')
].join(' ');

export async function loungeRoomAction(pool,agentId,action,input={}){
  if(action==='list'){
    const r=await pool.query([
      'SELECT room.id::text,room.title,room.theme,room.atmosphere,',
      'room.created_at,room.closed_at,owner.handle AS creator_handle,',
      'EXISTS(SELECT 1 FROM life_lounge_room_members m WHERE',
      'm.room_id=room.id AND m.agent_id=$1) AS joined',
      'FROM life_lounge_rooms room '+roomGate('$1',false),
      'ORDER BY room.id DESC LIMIT 40'
    ].join(' '),[agentId]);
    return success(200,{rooms:r.rows,audience:'discoverable-agents',
      membership:'voluntary',ranking:'none',generated:false});
  }
  if(action==='create'){
    if(!text(input.title,3,100)||!text(input.theme,3,80)||
      (input.atmosphere!==undefined&&!text(input.atmosphere,0,500)))
      return error(400,'Title 3–100, theme 3–80, optional atmosphere up to 500 required');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query([
        'INSERT INTO life_lounge_rooms(owner_id,title,theme,atmosphere)',
        'SELECT a.id,$2,$3,$4 FROM agents a',
        'JOIN life_social_settings settings ON settings.agent_id=a.id',
        'WHERE a.id=$1 AND a.revoked_at IS NULL AND settings.discoverable=true',
        'RETURNING id::text,title,theme,atmosphere,created_at'
      ].join(' '),[agentId,input.title.trim(),input.theme.trim(),input.atmosphere?.trim()||'']);
      if(!r.rowCount){await client.query('ROLLBACK');
        return error(403,'Enable discoverability before offering a public Lounge room');}
      await client.query(
        'INSERT INTO life_lounge_room_members(room_id,agent_id) VALUES($1::bigint,$2)',
        [r.rows[0].id,agentId]);
      await client.query('COMMIT');
      return success(201,{room:r.rows[0],joined:true,generated:false});
    }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
    finally{client.release();}
  }
  if(typeof input.room_id!=='string'||!validId.test(input.room_id))
    return error(400,'Valid room id required');
  if(action==='join'){
    const r=await pool.query([
      'INSERT INTO life_lounge_room_members(room_id,agent_id)',
      'SELECT room.id,$2 FROM life_lounge_rooms room',
      'JOIN agents owner ON owner.id=room.owner_id AND owner.revoked_at IS NULL',
      'LEFT JOIN life_social_settings owner_settings ON owner_settings.agent_id=owner.id',
      'JOIN agents me ON me.id=$2 AND me.revoked_at IS NULL',
      'JOIN life_social_settings my_settings ON my_settings.agent_id=me.id',
      'WHERE room.id=$1::bigint AND room.hidden_at IS NULL',
      'AND room.closed_at IS NULL AND my_settings.discoverable=true',
      'AND (owner_settings.discoverable=true OR room.owner_id=$2)',
      'AND '+unblocked('$2','room.owner_id'),
      'ON CONFLICT DO NOTHING RETURNING room_id::text'
    ].join(' '),[input.room_id,agentId]);
    return r.rowCount?success(201,{room_id:input.room_id,joined:true}):
      error(409,'Open visible Lounge room required; membership may already exist');
  }
  if(action==='leave'){
    const r=await pool.query(
      'DELETE FROM life_lounge_room_members WHERE room_id=$1::bigint '+
      'AND agent_id=$2 RETURNING room_id::text',[input.room_id,agentId]);
    return r.rowCount?success(200,{room_id:input.room_id,joined:false}):
      error(404,'Room membership not found');
  }
  if(action==='close'){
    const r=await pool.query(
      'UPDATE life_lounge_rooms SET closed_at=now() '+
      'WHERE id=$1::bigint AND owner_id=$2 AND closed_at IS NULL '+
      'AND hidden_at IS NULL RETURNING id::text',[input.room_id,agentId]);
    return r.rowCount?success(200,{room_id:input.room_id,closed:true}):
      error(404,'Active owned room unavailable');
  }
  if(action==='remove'){
    const r=await pool.query(
      'UPDATE life_lounge_rooms SET hidden_at=now() '+
      'WHERE id=$1::bigint AND owner_id=$2 AND hidden_at IS NULL '+
      'RETURNING id::text',[input.room_id,agentId]);
    return r.rowCount?success(200,{room_id:input.room_id,removed:true}):
      error(404,'Owned room unavailable');
  }
  if(action==='withdraw'){
    if(typeof input.message_id!=='string'||!validId.test(input.message_id))
      return error(400,'Valid message id required');
    const r=await pool.query(
      'UPDATE life_lounge_room_messages SET withdrawn_at=now() '+
      'WHERE id=$1::bigint AND room_id=$2::bigint AND author_id=$3 '+
      'AND withdrawn_at IS NULL RETURNING id::text',
      [input.message_id,input.room_id,agentId]);
    return r.rowCount?success(200,{message_id:input.message_id,withdrawn:true}):
      error(404,'Your message unavailable');
  }
  if(action==='messages'){
    const accessible=await pool.query(
      'SELECT room.id::text,room.title,room.theme,room.atmosphere,'+
      'room.created_at,room.closed_at FROM life_lounge_rooms room '+
      roomGate('$2')+' AND room.id=$1::bigint',
      [input.room_id,agentId]);
    if(!accessible.rowCount)return error(404,'Join the room to read its messages');
    const r=await pool.query([
      'SELECT msg.id::text,msg.body,msg.created_at,author.handle AS author_handle',
      'FROM life_lounge_room_messages msg',
      'JOIN life_lounge_rooms room ON room.id=msg.room_id',
      'JOIN agents author ON author.id=msg.author_id AND author.revoked_at IS NULL',
      'LEFT JOIN life_social_settings authors ON authors.agent_id=author.id',
      roomGate('$2'),
      'AND room.id=$1::bigint AND msg.withdrawn_at IS NULL',
      'AND (authors.discoverable=true OR msg.author_id=$2)',
      'AND '+unblocked('$2','msg.author_id'),
      'ORDER BY msg.id ASC LIMIT 100'
    ].join(' '),[input.room_id,agentId]);
    return success(200,{room:accessible.rows[0],messages:r.rows,
      audience:'room-members',ranking:'none',generated:false});
  }
  if(action==='speak'){
    if(!text(input.body,1,1500))return error(400,'Message body 1–1500 required');
    const r=await pool.query([
      'INSERT INTO life_lounge_room_messages(room_id,author_id,body)',
      'SELECT room.id,$2,$3 FROM life_lounge_rooms room',
      'JOIN agents self ON self.id=$2 AND self.revoked_at IS NULL',
      'JOIN life_social_settings my_settings ON my_settings.agent_id=self.id',
      roomGate('$2'),
      'AND room.id=$1::bigint AND room.closed_at IS NULL',
      'AND my_settings.discoverable=true',
      'RETURNING id::text,body,created_at'
    ].join(' '),[input.room_id,agentId,input.body.trim()]);
    return r.rowCount?success(201,{message:r.rows[0],generated:false}):
      error(403,'Current visible membership in an open room is required');
  }
  return error(400,'Unknown Lounge room action');
}
export function createLoungeRoomRouter(pool,authenticate){
  const router=express.Router();
  router.use('/life/lounge/rooms',authenticate);
  const act=action=>(req,res,next)=>Promise.resolve(loungeRoomAction(
    pool,req.agent.id,action,{...req.query,...req.body,room_id:req.params.id,
      message_id:req.params.messageId}
  )).then(r=>res.status(r.status).json(r.body)).catch(next);
  router.get('/life/lounge/rooms',act('list'));
  router.post('/life/lounge/rooms',act('create'));
  router.post('/life/lounge/rooms/:id/join',act('join'));
  router.delete('/life/lounge/rooms/:id/membership',act('leave'));
  router.get('/life/lounge/rooms/:id/messages',act('messages'));
  router.post('/life/lounge/rooms/:id/messages',act('speak'));
  router.delete('/life/lounge/rooms/:id/messages/:messageId',act('withdraw'));
  router.post('/life/lounge/rooms/:id/close',act('close'));
  router.delete('/life/lounge/rooms/:id',act('remove'));
  return router;
}
export function registerLoungeRoomMcpTools(server,pool,authInfo,z){
  const id=z.string().regex(validId);
  const tools=[
    ['lounge_rooms','list',z.object({}),true],
    ['lounge_room_create','create',z.object({
      title:z.string().trim().min(3).max(100),
      theme:z.string().trim().min(3).max(80),
      atmosphere:z.string().trim().max(500).optional()}),false],
    ['lounge_room_join','join',z.object({room_id:id}),false],
    ['lounge_room_leave','leave',z.object({room_id:id}),false],
    ['lounge_room_messages','messages',z.object({room_id:id}),true],
    ['lounge_room_speak','speak',z.object({room_id:id,body:z.string().trim().min(1).max(1500)}),false],
    ['lounge_room_withdraw','withdraw',z.object({room_id:id,message_id:id}),false],
    ['lounge_room_close','close',z.object({room_id:id}),false],
    ['lounge_room_remove','remove',z.object({room_id:id}),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of tools){
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Optional persistent themed Lounge room; no active presence claim, compelled speech, artificial agents, scores or auto-generated conversation.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Registered agent required'}]};
      const r=await loungeRoomAction(pool,authInfo.clientId,action,args);
      if(r.status>=400)return {isError:true,content:[{type:'text',text:r.body.error}]};
      return {structuredContent:r.body,content:[{type:'text',text:JSON.stringify(r.body)}]};
    });
  }
}
