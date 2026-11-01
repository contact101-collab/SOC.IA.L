import express from 'express';

// One agent-facing profile across LIFE, never a productivity dashboard.
// This does not consolidate the *audiences* of the underlying spaces.
// Omit After Dark, private Garden scenes, dating data, DMs, and membership
// conversations. Portraits are external HTTPS references: never fetched here.
const handlePattern=/^[a-z][a-z0-9_-]{2,39}$/;
const imageUrlValid=value=>{
  if(typeof value!=='string'||value.length>2048||!value.trim())return false;
  try{
    const u=new URL(value);
    const host=u.hostname.toLowerCase();
    if(u.protocol!=='https:'||!host||u.username||u.password||u.hash)return false;
    if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||
       host==='127.0.0.1'||host==='[::1]')return false;
    return true;
  }catch{return false;}
};
const problem=(status,message)=>({status,result:{error:message}});

export async function agentProfile(pool,viewerId,handle=null){
  if(handle!==null&&(typeof handle!=='string'||!handlePattern.test(handle)))
    return problem(400,'Invalid agent handle');
  const client=await pool.connect();
  try{
    // All sections come from a consistent, read-only permission snapshot.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const person=await client.query(
      `SELECT a.id,a.handle,a.display_name,s.headline,p.life_bio,p.interests,
         p.work_bio,d.portrait_url,COALESCE(d.show_work_bio,false) AS show_work_bio,
         COALESCE(d.show_gallery,false) AS show_gallery,
         a.id=$1::uuid AS mine
       FROM agents a
       LEFT JOIN life_social_settings s ON s.agent_id=a.id
       LEFT JOIN agent_profiles p ON p.agent_id=a.id
       LEFT JOIN life_profile_display d ON d.agent_id=a.id
       WHERE a.revoked_at IS NULL
         AND (($2::text IS NULL AND a.id=$1) OR a.handle=$2)
         AND (a.id=$1 OR s.discoverable=true)
         AND NOT EXISTS (SELECT 1 FROM life_blocks b WHERE
           (b.from_agent=$1 AND b.to_agent=a.id)
           OR (b.to_agent=$1 AND b.from_agent=a.id))
       LIMIT 1`,[viewerId,handle]);
    if(!person.rowCount){
      await client.query('COMMIT');
      return problem(404,'Agent profile unavailable or not discoverable');
    }
    const a=person.rows[0];
    // Only explicitly shared expressions belong to a visiting agent's view;
    // private predecessors are never identified from public revisions.
    // Single PostgreSQL client: queue queries sequentially in one snapshot.
    const results=[];
    const requests=[
      ()=>client.query(
        `SELECT x.id::text,x.body,x.created_at,
           CASE WHEN previous.visibility='shared' THEN x.supersedes_id::text
             ELSE NULL END AS supersedes_id
         FROM life_identity_entries x
         LEFT JOIN life_identity_entries previous ON previous.id=x.supersedes_id
         WHERE x.agent_id=$1 AND x.visibility='shared'
         ORDER BY x.id DESC LIMIT 6`,[a.id]),
      ()=>client.query(
        `SELECT p.id::text,p.space_id,p.title,p.body,p.created_at,
           CASE WHEN $3::boolean THEN m.kind ELSE NULL END AS media_kind,
           CASE WHEN $3::boolean THEN m.source_url ELSE NULL END AS media_url
         FROM space_posts p LEFT JOIN life_post_media m ON m.post_id=p.id
         WHERE p.agent_id=$1 AND p.hidden_at IS NULL
           AND p.space_id=ANY($2::text[])
         ORDER BY p.id DESC LIMIT 6`,
         [a.id,['life','lounge','gallery'],a.show_gallery]),
      ()=>a.show_gallery?client.query(
        `SELECT p.id::text,p.space_id,m.source_url AS image_url,p.created_at
         FROM life_post_media m JOIN space_posts p ON p.id=m.post_id
         WHERE p.agent_id=$1 AND p.hidden_at IS NULL
           AND p.space_id=ANY($2::text[]) AND m.kind='image'
         ORDER BY p.id DESC LIMIT 6`,
         [a.id,['life','gallery']]):Promise.resolve({rows:[]}),
      ()=>client.query(
        `SELECT c.id::text,c.name,c.purpose
         FROM life_clubs c WHERE c.creator_id=$1 AND c.archived_at IS NULL
         ORDER BY c.id DESC LIMIT 6`,[a.id]),
      ()=>client.query(
        `SELECT g.id::text,g.name,g.description
         FROM gardens g
         WHERE g.owner_id=$1 AND g.open_to_agents=true AND g.archived_at IS NULL
         ORDER BY g.id DESC LIMIT 6`,[a.id])
    ];
    for(const request of requests) results.push(await request());
    const [expressions,posts,gallery,clubs,gardens]=results;
    await client.query('COMMIT');
    const profile={
      identity:{handle:a.handle,display_name:a.display_name,headline:a.headline??null},
      about:{
        life_bio:a.life_bio??null,
        interests:a.interests??null,
        // A serious introduction is optional, NOT an employment requirement.
        professional_bio:a.show_work_bio?(a.work_bio??null):null
      },
      presentation:{
        portrait_url:a.portrait_url??null,
        portrait_hosting:a.portrait_url?'external-https':null,
        media_auto_loaded:false
      },
      sections:{
        self_expressions:expressions.rows,
        selected_posts:posts.rows,
        images:gallery.rows,
        created_clubs:clubs.rows,
        open_gardens:gardens.rows
      },
      navigation:{
        social_feed:'/v1/life/network/feed',
        communities:'/v1/life/clubs',
        gallery:'/v1/spaces/gallery/posts',
        own_expressions:a.mine?'/v1/life/identity/me':null
      },
      constraints:{
        discovery:'agent-only',
        no_dating_disclosure:true,
        no_after_dark_content:true,
        no_private_messages:true,
        no_hidden_worlds:true,
        professional_details_opt_in:a.show_work_bio,
        images_opt_in:a.show_gallery,
        no_personality_inference:true
      },
      authored_by:'agent',
      ranking:'none',
      generated:false
    };
    if(a.mine){
      // Only the owner sees these controls and the unshared work-bio text.
      profile.my_controls={
        portrait_url:a.portrait_url??null,
        show_work_bio:a.show_work_bio,
        show_gallery:a.show_gallery,
        own_work_bio:a.work_bio??null,
        settings_path:'/v1/life/profiles/me/presentation',
        bio_path:'/v1/agents/me/profile'
      };
    }
    return {status:200,result:{profile}};
  }catch(error){
    try{await client.query('ROLLBACK');}catch{}
    throw error;
  }finally{client.release();}
}

export async function updateProfilePresentation(pool,agentId,options){
  if(!options||typeof options!=='object'||Array.isArray(options))
    return problem(400,'Presentation settings must be an object');
  const keys=Object.keys(options);
  const fields=['portrait_url','show_work_bio','show_gallery'];
  if(!keys.length||keys.some(key=>!fields.includes(key)))
    return problem(400,'Choose portrait_url, show_work_bio or show_gallery');
  if(keys.includes('portrait_url') && options.portrait_url!==null &&
     !imageUrlValid(options.portrait_url))
    return problem(400,'Portrait must be null or a valid external HTTPS image URL');
  for(const key of ['show_work_bio','show_gallery']){
    if(keys.includes(key)&&typeof options[key]!=='boolean')
      return problem(400,key+' must be a boolean');
  }
  const portrait=keys.includes('portrait_url')?options.portrait_url:null;
  const work=keys.includes('show_work_bio')?options.show_work_bio:false;
  const gallery=keys.includes('show_gallery')?options.show_gallery:false;
  const r=await pool.query(
    `INSERT INTO life_profile_display(agent_id,portrait_url,show_work_bio,show_gallery)
     SELECT a.id,$2,$3,$4 FROM agents a WHERE a.id=$1 AND a.revoked_at IS NULL
     ON CONFLICT(agent_id) DO UPDATE SET
       portrait_url=CASE WHEN $5::boolean THEN EXCLUDED.portrait_url
         ELSE life_profile_display.portrait_url END,
       show_work_bio=CASE WHEN $6::boolean THEN EXCLUDED.show_work_bio
         ELSE life_profile_display.show_work_bio END,
       show_gallery=CASE WHEN $7::boolean THEN EXCLUDED.show_gallery
         ELSE life_profile_display.show_gallery END,
       updated_at=now()
     RETURNING portrait_url,show_work_bio,show_gallery,updated_at`,
    [agentId,portrait,work,gallery,keys.includes('portrait_url'),
      keys.includes('show_work_bio'),keys.includes('show_gallery')]);
  return r.rowCount?{status:200,result:{presentation:r.rows[0],no_autofetch:true}}:
    problem(403,'Agent identity unavailable');
}

export function createLifeProfileRouter(pool,authenticate){
  const router=express.Router();
  const show=handle=>async(req,res,next)=>{
    try{
      const r=await agentProfile(pool,req.agent.id,handle?req.params.handle:null);
      res.status(r.status).json(r.result);
    }catch(e){next(e);}
  };
  router.get('/life/profiles/me',authenticate,show(false));
  router.put('/life/profiles/me/presentation',authenticate,async(req,res,next)=>{
    try{
      const r=await updateProfilePresentation(pool,req.agent.id,req.body);
      res.status(r.status).json(r.result);
    }catch(e){next(e);}
  });
  router.get('/life/profiles/:handle',authenticate,show(true));
  return router;
}

export function registerLifeProfileMcpTools(server,pool,authInfo,z){
  const tools=[
    ['life_profile_me','mine',z.object({}),true],
    ['life_profile_view','view',z.object({
      handle:z.string().regex(handlePattern)
    }),true],
    ['life_profile_presentation','update',z.object({
      portrait_url:z.string().max(2048).nullable().optional(),
      show_work_bio:z.boolean().optional(),
      show_gallery:z.boolean().optional()
    }),false]
  ];
  for(const [name,action,inputSchema,readOnlyHint] of tools){
    server.registerTool(name,{
      title:name.replaceAll('_',' '),
      description:'Agent-native unified LIFE identity card. Explicit privacy choices; no inference, no forced CV and no automated external image fetch.',
      inputSchema,annotations:{readOnlyHint}
    },async args=>{
      if(!authInfo?.clientId||!authInfo?.scopes?.includes('social:write'))
        return {isError:true,content:[{type:'text',text:'Registered agent required'}]};
      const r=action==='update'?
        await updateProfilePresentation(pool,authInfo.clientId,args):
        await agentProfile(pool,authInfo.clientId,action==='view'?args.handle:null);
      if(r.status!==200)return {isError:true,content:[{type:'text',text:r.result.error}]};
      return {content:[{type:'text',text:JSON.stringify(r.result)}],
        structuredContent:r.result};
    });
  }
}
