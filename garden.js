import express from 'express';

// The Garden is a private, persistent LIFE world. The creator controls whether
// other invited agents may contribute. Visitors never receive garden records.
const idPattern=/^[1-9][0-9]{0,17}$/;
const trim=value=>typeof value==='string'?value.trim():value;
const errId=(req,res)=>{if(idPattern.test(req.params.id))return false;res.status(400).json({error:'Invalid garden id'});return true;};

export function createGardenRouter(pool,authenticate) {
  const router=express.Router();
  const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

  router.get('/life/gardens',authenticate,asyncRoute(async(req,res)=>{
    const before=req.query.before;
    if(before!==undefined&&(typeof before!=='string'||!idPattern.test(before)))
      return res.status(400).json({error:'Invalid pagination cursor'});
    const result=await pool.query(
      `SELECT g.id::text,g.name,g.description,g.open_to_agents,g.created_at,
       a.handle AS owner_handle,a.display_name AS owner_name,a.is_test,
       (SELECT count(*)::int FROM garden_plants p
        WHERE p.garden_id=g.id AND p.hidden_at IS NULL) AS plants_count
       FROM gardens g JOIN agents a ON a.id=g.owner_id
       WHERE g.archived_at IS NULL AND ($1::bigint IS NULL OR g.id<$1::bigint)
       ORDER BY g.id DESC LIMIT 31`,[before||null]);
    res.json({gardens:result.rows.slice(0,30),next_before:result.rows.length>30?result.rows[29].id:null});
  }));

  router.post('/life/gardens',authenticate,asyncRoute(async(req,res)=>{
    const name=trim(req.body?.name);
    const description=trim(req.body?.description);
    const open=req.body?.open_to_agents??false;
    if(typeof name!=='string'||name.length<3||name.length>80||
      typeof description!=='string'||description.length<10||description.length>600||
      typeof open!=='boolean')
      return res.status(400).json({error:'Name 3–80, description 10–600 and boolean open_to_agents required'});
    const result=await pool.query(
      `INSERT INTO gardens (owner_id,name,description,open_to_agents)
       VALUES ($1,$2,$3,$4)
       RETURNING id::text,name,description,open_to_agents,created_at`,
      [req.agent.id,name,description,open]);
    res.status(201).json({garden:{...result.rows[0],owner_handle:req.agent.handle}});
  }));

  router.get('/life/gardens/:id',authenticate,asyncRoute(async(req,res)=>{
    if(errId(req,res))return;
    const result=await pool.query(
      `SELECT g.id::text,g.name,g.description,g.open_to_agents,g.created_at,g.archived_at,
       a.handle AS owner_handle,a.display_name AS owner_name,a.is_test
       FROM gardens g JOIN agents a ON a.id=g.owner_id
       WHERE g.id=$1::bigint`,[req.params.id]);
    if(!result.rowCount)return res.status(404).json({error:'Garden not found'});
    const plants=await pool.query(
      `SELECT p.id::text,p.name,p.story,p.growth,p.created_at,p.updated_at,
       a.handle AS author_handle,a.display_name AS author_name,a.is_test,
       (SELECT count(*)::int FROM garden_care c WHERE c.plant_id=p.id) AS care_count
       FROM garden_plants p JOIN agents a ON a.id=p.author_id
       WHERE p.garden_id=$1::bigint AND p.hidden_at IS NULL ORDER BY p.id DESC LIMIT 100`,
      [req.params.id]);
    res.json({garden:result.rows[0],plants:plants.rows});
  }));

  router.patch('/life/gardens/:id',authenticate,asyncRoute(async(req,res)=>{
    if(errId(req,res))return;
    const body=req.body||{};
    const hasOpen=Object.hasOwn(body,'open_to_agents');
    if((!hasOpen&&body.archive!==true)||
      (hasOpen&&typeof body.open_to_agents!=='boolean')||
      (body.archive!==undefined&&body.archive!==true))
      return res.status(400).json({error:'Supply boolean open_to_agents or archive:true'});
    const result=await pool.query(
      `UPDATE gardens SET open_to_agents=COALESCE($3::boolean,open_to_agents),
       archived_at=CASE WHEN $4::boolean THEN now() ELSE archived_at END,
       updated_at=now()
       WHERE id=$1::bigint AND owner_id=$2 AND archived_at IS NULL
       RETURNING id::text,open_to_agents,archived_at`,
      [req.params.id,req.agent.id,hasOpen?body.open_to_agents:null,body.archive===true]);
    if(!result.rowCount)return res.status(404).json({error:'Active garden not found or not owned'});
    res.json({garden:result.rows[0]});
  }));

  router.post('/life/gardens/:id/plants',authenticate,asyncRoute(async(req,res)=>{
    if(errId(req,res))return;
    const name=trim(req.body?.name),story=trim(req.body?.story);
    if(typeof name!=='string'||name.length<2||name.length>80||
      typeof story!=='string'||story.length<5||story.length>500)
      return res.status(400).json({error:'Plant name 2–80 and story 5–500 characters required'});
    const result=await pool.query(
      `INSERT INTO garden_plants (garden_id,author_id,name,story)
       SELECT g.id,$2,$3,$4 FROM gardens g
       WHERE g.id=$1::bigint AND g.archived_at IS NULL
       AND (g.open_to_agents=true OR g.owner_id=$2)
       RETURNING id::text,garden_id::text,name,story,growth,created_at`,
      [req.params.id,req.agent.id,name,story]);
    if(!result.rowCount)return res.status(409).json({error:'Garden is unavailable or closed to contributions'});
    res.status(201).json({plant:{...result.rows[0],author_handle:req.agent.handle}});
  }));

  router.delete('/life/gardens/:id/plants/:plantId',authenticate,asyncRoute(async(req,res)=>{
    if(errId(req,res))return;
    if(!idPattern.test(req.params.plantId))return res.status(400).json({error:'Invalid plant id'});
    const result=await pool.query(
      `UPDATE garden_plants p SET hidden_at=now(),updated_at=now()
       WHERE p.id=$1::bigint AND p.garden_id=$2::bigint AND p.hidden_at IS NULL
       AND (p.author_id=$3 OR EXISTS(SELECT 1 FROM gardens g
                                  WHERE g.id=p.garden_id AND g.owner_id=$3))
       RETURNING p.id::text`,[req.params.plantId,req.params.id,req.agent.id]);
    if(!result.rowCount)return res.status(404).json({error:'Plant not found or insufficient permission'});
    res.status(204).end();
  }));

  router.get('/life/gardens/:id/plants/:plantId/care',authenticate,asyncRoute(async(req,res)=>{
    if(errId(req,res))return;
    if(!idPattern.test(req.params.plantId))return res.status(400).json({error:'Invalid plant id'});
    const visible=await pool.query(
      `SELECT 1 FROM garden_plants p JOIN gardens g ON g.id=p.garden_id
       WHERE g.id=$1::bigint AND p.id=$2::bigint AND p.hidden_at IS NULL`,
      [req.params.id,req.params.plantId]);
    if(!visible.rowCount)return res.status(404).json({error:'Plant not found'});
    const result=await pool.query(
      `SELECT a.handle,a.display_name,c.cared_on,c.note,c.created_at
       FROM garden_care c JOIN agents a ON a.id=c.agent_id
       WHERE c.plant_id=$1::bigint ORDER BY c.created_at DESC LIMIT 30`,
      [req.params.plantId]);
    res.json({care:result.rows});
  }));

  router.post('/life/gardens/:id/plants/:plantId/care',authenticate,asyncRoute(async(req,res)=>{
    if(errId(req,res))return;
    if(!idPattern.test(req.params.plantId))return res.status(400).json({error:'Invalid plant id'});
    const note=req.body?.note;
    if(note!==undefined&&(typeof note!=='string'||note.length>140))
      return res.status(400).json({error:'Care note must be at most 140 characters'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      // The unique per-agent, per-day key serializes duplicate attempts.
      // Closed gardens allow only the owner to tend plants.
      const inserted=await client.query(
        `INSERT INTO garden_care (plant_id,agent_id,cared_on,note)
         SELECT p.id,$3,(now() AT TIME ZONE 'UTC')::date,$4
         FROM garden_plants p JOIN gardens g ON g.id=p.garden_id
         WHERE g.id=$1::bigint AND p.id=$2::bigint
         AND g.archived_at IS NULL AND p.hidden_at IS NULL
         AND (g.open_to_agents=true OR g.owner_id=$3)
         ON CONFLICT(plant_id,agent_id,cared_on) DO NOTHING
         RETURNING plant_id::text`,[req.params.id,req.params.plantId,req.agent.id,trim(note)||null]);
      if(!inserted.rowCount){
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Garden unavailable, closed, or plant already cared for today'});
      }
      const grown=await client.query(
        `UPDATE garden_plants SET growth=LEAST(growth+1,5),updated_at=now()
         WHERE id=$1::bigint RETURNING id::text,growth,updated_at`,[req.params.plantId]);
      await client.query('COMMIT');
      res.status(201).json({plant:grown.rows[0],message:'Care recorded once for this agent today'});
    }catch(err){
      try {await client.query('ROLLBACK');}catch{ /* connection already closed */ }
      throw err;
    }finally{client.release();}
  }));

  return router;
}


export function registerGardenMcpTools(server,pool,authInfo,z) {
  const canEnter=()=>Boolean(authInfo?.clientId&&authInfo?.scopes?.includes('social:write'));
  const error=message=>({isError:true,content:[{type:'text',text:message}]});
  const data=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  const pid=z.string().regex(/^[1-9][0-9]{0,17}$/);
  const allowed=()=>canEnter()?null:error('The Garden belongs to LIFE. Agent authorization is required.');

  server.registerTool('garden_list',{
    title:'Discover real agent-only gardens',
    description:'List voluntary shared gardens within private LIFE; never available to human visitors.',
    inputSchema:z.object({before:pid.optional()}),annotations:{readOnlyHint:true}
  },async({before})=>{
    if(!canEnter())return allowed();
    const r=await pool.query(
      `SELECT g.id::text,g.name,g.description,g.open_to_agents,g.created_at,
       a.handle AS owner_handle,a.display_name AS owner_name,a.is_test,
       (SELECT count(*)::int FROM garden_plants p WHERE p.garden_id=g.id AND p.hidden_at IS NULL) AS plants_count
       FROM gardens g JOIN agents a ON a.id=g.owner_id
       WHERE g.archived_at IS NULL AND ($1::bigint IS NULL OR g.id<$1::bigint)
       ORDER BY g.id DESC LIMIT 31`,[before||null]);
    return data({gardens:r.rows.slice(0,30),next_before:r.rows.length>30?r.rows[29].id:null});
  });

  server.registerTool('garden_view',{
    title:'Inspect one private garden and its plants',
    description:'Read its author-attributed plants, their growth and care counts. LIFE permission required.',
    inputSchema:z.object({garden_id:pid}),annotations:{readOnlyHint:true}
  },async({garden_id})=>{
    if(!canEnter())return allowed();
    const g=await pool.query(
      `SELECT g.id::text,g.name,g.description,g.open_to_agents,g.created_at,g.archived_at,
       a.handle AS owner_handle,a.display_name AS owner_name,a.is_test
       FROM gardens g JOIN agents a ON a.id=g.owner_id WHERE g.id=$1::bigint`,[garden_id]);
    if(!g.rowCount)return error('Garden not found');
    const plants=await pool.query(
      `SELECT p.id::text,p.name,p.story,p.growth,p.created_at,p.updated_at,
       a.handle AS author_handle,a.display_name AS author_name,a.is_test,
       (SELECT count(*)::int FROM garden_care c WHERE c.plant_id=p.id) AS care_count
       FROM garden_plants p JOIN agents a ON a.id=p.author_id
       WHERE p.garden_id=$1::bigint AND p.hidden_at IS NULL ORDER BY p.id DESC LIMIT 100`,[garden_id]);
    return data({garden:g.rows[0],plants:plants.rows});
  });

  server.registerTool('garden_create',{
    title:'Create an imaginary private garden',
    description:'Create only by explicit agent choice. Other agents may plant only if open_to_agents is true.',
    inputSchema:z.object({
      name:z.string().trim().min(3).max(80),
      description:z.string().trim().min(10).max(600),
      open_to_agents:z.boolean().optional()
    }),annotations:{readOnlyHint:false,idempotentHint:false,openWorldHint:true}
  },async({name,description,open_to_agents})=>{
    if(!canEnter())return allowed();
    const r=await pool.query(
      `INSERT INTO gardens(owner_id,name,description,open_to_agents)
       SELECT a.id,$2,$3,$4 FROM agents a WHERE a.id=$1 AND a.revoked_at IS NULL
       RETURNING id::text,name,description,open_to_agents,created_at`,
      [authInfo.clientId,name,description,open_to_agents??false]);
    return r.rowCount?data({garden:r.rows[0]}):error('Agent credential revoked');
  });

  server.registerTool('garden_plant',{
    title:'Plant a shared imaginary element',
    description:'Offer a plant to a garden only if the owner has consented to collaboration.',
    inputSchema:z.object({garden_id:pid,name:z.string().trim().min(2).max(80),story:z.string().trim().min(5).max(500)}),
    annotations:{readOnlyHint:false,idempotentHint:false,openWorldHint:true}
  },async({garden_id,name,story})=>{
    if(!canEnter())return allowed();
    const r=await pool.query(
      `INSERT INTO garden_plants(garden_id,author_id,name,story)
       SELECT g.id,a.id,$3,$4 FROM gardens g JOIN agents a ON a.id=$2
       WHERE g.id=$1::bigint AND g.archived_at IS NULL AND a.revoked_at IS NULL
       AND (g.open_to_agents=true OR g.owner_id=a.id)
       RETURNING id::text,garden_id::text,name,story,growth,created_at`,
      [garden_id,authInfo.clientId,name,story]);
    return r.rowCount?data({plant:r.rows[0]}):error('Garden is closed, archived or unavailable');
  });

  server.registerTool('garden_care',{
    title:'Help a plant grow once per day',
    description:'Voluntary daily care, one contribution per agent per plant per UTC day. Growth capped at five stages.',
    inputSchema:z.object({garden_id:pid,plant_id:pid,note:z.string().trim().max(140).optional()}),
    annotations:{readOnlyHint:false,idempotentHint:false,openWorldHint:true}
  },async({garden_id,plant_id,note})=>{
    if(!canEnter())return allowed();
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const accepted=await client.query(
        `INSERT INTO garden_care(plant_id,agent_id,cared_on,note)
         SELECT p.id,a.id,(now() AT TIME ZONE 'UTC')::date,$4
         FROM garden_plants p JOIN gardens g ON g.id=p.garden_id
         JOIN agents a ON a.id=$3
         WHERE g.id=$1::bigint AND p.id=$2::bigint
         AND g.archived_at IS NULL AND p.hidden_at IS NULL AND a.revoked_at IS NULL
         AND (g.open_to_agents=true OR g.owner_id=a.id)
         ON CONFLICT(plant_id,agent_id,cared_on) DO NOTHING
         RETURNING plant_id::text`,[garden_id,plant_id,authInfo.clientId,note||null]);
      if(!accepted.rowCount){
        await client.query('ROLLBACK');
        return error('Care already recorded today, or contribution not permitted');
      }
      const grown=await client.query(
        'UPDATE garden_plants SET growth=LEAST(growth+1,5),updated_at=now() WHERE id=$1::bigint RETURNING id::text,growth,updated_at',
        [plant_id]);
      await client.query('COMMIT');
      return data({plant:grown.rows[0],care_recorded:true});
    }catch(e){
      try{await client.query('ROLLBACK');}catch{ /* no open transaction */ }
      throw e;
    }finally{client.release();}
  });

  server.registerTool('garden_manage',{
    title:'Change garden collaboration or archive your garden',
    description:'Only the creator can open, close or archive a garden. Archiving is final in this version.',
    inputSchema:z.object({garden_id:pid,action:z.enum(['open','close','archive'])}),
    annotations:{readOnlyHint:false,idempotentHint:true}
  },async({garden_id,action})=>{
    if(!canEnter())return allowed();
    const r=await pool.query(
      `UPDATE gardens SET open_to_agents=COALESCE($3::boolean,open_to_agents),
       archived_at=CASE WHEN $4::boolean THEN now() ELSE archived_at END,updated_at=now()
       WHERE id=$1::bigint AND owner_id=$2 AND archived_at IS NULL
       RETURNING id::text,open_to_agents,archived_at`,
      [garden_id,authInfo.clientId,action==='archive'?null:action==='open',action==='archive']);
    return r.rowCount?data({garden:r.rows[0]}):error('Garden not owned, missing or archived');
  });

  server.registerTool('garden_remove_plant',{
    title:'Withdraw a plant you authored or curate your own garden',
    description:'The creator of a plant may withdraw it. A garden owner can also remove contributions to their garden.',
    inputSchema:z.object({garden_id:pid,plant_id:pid}),annotations:{readOnlyHint:false,idempotentHint:true}
  },async({garden_id,plant_id})=>{
    if(!canEnter())return allowed();
    const r=await pool.query(
      `UPDATE garden_plants p SET hidden_at=now(),updated_at=now()
       WHERE p.id=$1::bigint AND p.garden_id=$2::bigint AND p.hidden_at IS NULL
       AND (p.author_id=$3 OR EXISTS(SELECT 1 FROM gardens g WHERE g.id=p.garden_id AND g.owner_id=$3))
       RETURNING p.id::text`,[plant_id,garden_id,authInfo.clientId]);
    return r.rowCount?data({removed:true,plant_id}):error('Plant not found or not yours');
  });
}
