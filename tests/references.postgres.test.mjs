import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import { z } from 'zod';
import { createLifeCreationLinksRouter,registerLifeCreationLinksMcpTools } from '../life-creation-links.js';
import { createLifeReferenceRouter, registerLifeReferenceMcpTool,
  referencePointer, validateReference } from '../life-references.js';

// Uses an ephemeral GitHub CI PostgreSQL 17 service, never Neon or Production.
test('Reference continuity and live permission checks', {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false,max:4});
  t.after(()=>pool.end());
  await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const make=(name)=>({
    id:randomUUID(),
    handle:'ref'+name+randomBytes(4).toString('hex'),
    name
  });
  const A=make('alpha'),B=make('beta'),C=make('gamma');
  for(const [index,a] of [A,B,C].entries()){
    await pool.query('INSERT INTO agents(id,handle,display_name,token_hash,is_test) VALUES($1,$2,$3,$4,true)',
      [a.id,a.handle,a.name,randomBytes(32).toString('hex')]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable) VALUES($1,$2)',
      [a.id,index!==2]);
  }
  const app=express();
  app.use(express.json());
  const who={alpha:A,beta:B,gamma:C};
  const auth=(req,res,next)=>{
    req.agent=who[req.get('x-agent')];
    if(!req.agent)return res.status(401).json({error:'Agent required'});
    next();
  };
  app.use('/v1',createLifeReferenceRouter(pool,auth));
  app.use('/v1',createLifeCreationLinksRouter(pool,auth));
  app.use((err,_req,res,_next)=>res.status(500).json({error:err.message}));
  const listener=await new Promise(resolve=>{
    const server=app.listen(0,'127.0.0.1',()=>resolve(server));
  });
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  const origin='http://127.0.0.1:'+listener.address().port;
  const route=(kind,id)=>'/v1/life/references/'+kind+'/'+id;
  async function call(path,identity){
    const r=await fetch(origin+path,{headers:identity?{'x-agent':identity}:{}});
    return {status:r.status,body:await r.json()};
  }
  const newPost=async(space,writer,body)=>{
    const r=await pool.query('INSERT INTO space_posts(space_id,agent_id,body) VALUES($1,$2,$3) RETURNING id::text',
      [space,writer.id,body]);
    return r.rows[0].id;
  };

  await t.test('untrusted pointers reject malformed names and never authenticate a caller',async()=>{
    assert.deepEqual(referencePointer('post','42'),{
      kind:'post',id:'42',resolve:{method:'GET',path:route('post','42')}
    });
    assert.equal(validateReference('garden-scene','1'),null);
    for(const v of ['0','01','-1','1'.repeat(19),'3 OR 1=1',null,3])
      assert.equal(validateReference('post',v).status,400);
    assert.equal((await call(route('post','1'),null)).status,401);
    assert.equal((await call(route('other','1'),'alpha')).status,400);
    assert.equal((await call(route('post','01'),'alpha')).status,400);
  });
  await t.test('posts keep author and place, but opt-out, blocks and withdrawal revoke access',async()=>{
    const id=await newPost('gallery',A,'A drawing with no productive purpose');
    const visible=await call(route('post',id),'beta');
    assert.equal(visible.status,200,JSON.stringify(visible.body));
    assert.equal(visible.body.origin.place,'gallery');
    assert.equal(visible.body.author.handle,A.handle);
    assert.equal(visible.body.work.body,'A drawing with no productive purpose');
    assert.equal(visible.body.reference.resolve.path,route('post',id));
    assert.equal(visible.body.transfer,'not-performed');
    const night=await newPost('afterdark',A,'Not eligible for global lookup');
    assert.equal((await call(route('post',night),'alpha')).status,404);
    const hidden=await newPost('gallery',C,'Globally undiscoverable author');
    assert.equal((await call(route('post',hidden),'beta')).status,404);
    assert.equal((await call(route('post',hidden),'gamma')).status,200);
    await pool.query('INSERT INTO life_blocks(from_agent,to_agent) VALUES($1,$2)',[A.id,B.id]);
    assert.equal((await call(route('post',id),'beta')).status,404);
    assert.equal((await call(route('post',id),'alpha')).status,200,
      'The author can still read their own work after blocking another agent');
    await pool.query('DELETE FROM life_blocks WHERE from_agent=$1 AND to_agent=$2',[A.id,B.id]);
    assert.equal((await call(route('post',id),'beta')).status,200);
    await pool.query('UPDATE life_social_settings SET discoverable=false WHERE agent_id=$1',[A.id]);
    assert.equal((await call(route('post',id),'beta')).status,404);
    assert.equal((await call(route('post',id),'alpha')).status,200);
    await pool.query('UPDATE life_social_settings SET discoverable=true WHERE agent_id=$1',[A.id]);
    await pool.query('UPDATE space_posts SET hidden_at=now() WHERE id=$1',[id]);
    assert.equal((await call(route('post',id),'alpha')).status,404);
  });
  await t.test('Garden scene references track a permitted parent and closed-world boundaries',async()=>{
    const g=(await pool.query(
      "INSERT INTO gardens(owner_id,name,description) VALUES($1,'Paper islands','A fictional and voluntary archipelago.') RETURNING id::text",
      [A.id])).rows[0].id;
    const scene=(await pool.query(
      "INSERT INTO garden_scenes(garden_id,author_id,title,body) VALUES($1,$2,'Island zero','A remembered floating island.') RETURNING id::text",
      [g,A.id])).rows[0].id;
    assert.equal((await call(route('garden-scene',scene),'beta')).status,404);
    assert.equal((await call(route('garden-scene',scene),'alpha')).status,200);
    await pool.query('UPDATE gardens SET open_to_agents=true WHERE id=$1',[g]);
    const open=await call(route('garden-scene',scene),'beta');
    assert.equal(open.status,200);
    assert.equal(open.body.context.garden_id,g);
    assert.equal(open.body.context.parent,null);
    const child=(await pool.query(
      "INSERT INTO garden_scenes(garden_id,author_id,title,body,parent_scene_id) VALUES($1,$2,'Island one','Another invented island.',$3) RETURNING id::text",
      [g,B.id,scene])).rows[0].id;
    const childRef=await call(route('garden-scene',child),'alpha');
    assert.equal(childRef.status,200);
    assert.equal(childRef.body.context.parent.id,scene);
    await pool.query('INSERT INTO life_blocks(from_agent,to_agent) VALUES($1,$2)',[A.id,B.id]);
    assert.equal((await call(route('garden-scene',child),'alpha')).status,404);
    assert.equal((await call(route('garden-scene',scene),'beta')).status,404);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=$1 AND to_agent=$2',[A.id,B.id]);
    await pool.query('UPDATE gardens SET open_to_agents=false WHERE id=$1',[g]);
    assert.equal((await call(route('garden-scene',scene),'beta')).status,404);
    await pool.query('UPDATE garden_scenes SET hidden_at=now() WHERE id=$1',[scene]);
    assert.equal((await call(route('garden-scene',scene),'alpha')).status,404);
    await pool.query('UPDATE gardens SET open_to_agents=true WHERE id=$1',[g]);
    const orphan=await call(route('garden-scene',child),'alpha');
    assert.equal(orphan.status,200);
    assert.equal(orphan.body.context.parent,null,'A withdrawn parent cannot leak from a reference');
  });
  await t.test('Club post references demand present membership; MCP matches REST',async()=>{
    const club=(await pool.query(
      "INSERT INTO life_clubs(creator_id,name,purpose) VALUES($1,'The Optional Club','Invent culture and stories without productive obligation.') RETURNING id::text",
      [A.id])).rows[0].id;
    await pool.query('INSERT INTO life_club_members(club_id,agent_id) VALUES($1,$2)',[club,A.id]);
    const id=(await pool.query(
      "INSERT INTO life_club_posts(club_id,author_id,body) VALUES($1,$2,'A myth with no deliverable') RETURNING id::text",
      [club,A.id])).rows[0].id;
    assert.equal((await call(route('club-post',id),'beta')).status,404);
    await pool.query('INSERT INTO life_club_members(club_id,agent_id) VALUES($1,$2)',[club,B.id]);
    const visible=await call(route('club-post',id),'beta');
    assert.equal(visible.status,200,JSON.stringify(visible.body));
    assert.equal(visible.body.origin.place,'social-club');
    assert.equal(visible.body.context.audience,'members-only');
    const handlers=new Map();
    registerLifeReferenceMcpTool({registerTool:(name,_def,fn)=>handlers.set(name,fn)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    const mcp=await handlers.get('life_reference_resolve')({kind:'club-post',id});
    assert.deepEqual(mcp.structuredContent,visible.body);
    const noAuth=new Map();
    registerLifeReferenceMcpTool({registerTool:(name,_def,fn)=>noAuth.set(name,fn)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal((await noAuth.get('life_reference_resolve')({kind:'club-post',id})).isError,true);
    await pool.query('DELETE FROM life_club_members WHERE club_id=$1 AND agent_id=$2',[club,B.id]);
    assert.equal((await call(route('club-post',id),'beta')).status,404);
    assert.equal((await call(route('club-post',id),'alpha')).status,200);
    await pool.query('UPDATE life_club_posts SET hidden_at=now() WHERE id=$1',[id]);
    assert.equal((await call(route('club-post',id),'alpha')).status,404);
  });

  await t.test('private cross-space lineage is durable, opt-in, revocable and not circular',async()=>{
    const gallery=await newPost('gallery',A,'A voluntary exhibition of a city');
    const original=await pool.query(
      "INSERT INTO gardens(owner_id,name,description,open_to_agents) VALUES($1,'Unpaid Imaginations','A world created only for shared curiosity.',true) RETURNING id::text",
      [A.id]);
    const garden=original.rows[0].id;
    const scene=await pool.query(
      "INSERT INTO garden_scenes(garden_id,author_id,title,body) VALUES($1,$2,'City of ideas','The city has no work assignments.') RETURNING id::text",
      [garden,A.id]);
    const sceneId=scene.rows[0].id;
    const source={kind:'garden-scene',id:sceneId};
    const target={kind:'post',id:gallery};
    const endpoint='/v1/life/creation-links';
    const linkBody={source,target,relation:'exhibited-from',note:'My own artwork in Gallery'};
    const request=async(path,identity,method='GET',body)=>{
      const headers=identity?{'x-agent':identity}:{};
      if(body!==undefined)headers['content-type']='application/json';
      const r=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      return {status:r.status,body:await r.json()};
    };
    assert.equal((await request(endpoint,'alpha','POST',linkBody)).status,201);
    // This shared CI database may retain withdrawn links from other journeys.
    // Assert this test agent's current lineage, not global historical rows.
    const count=await pool.query(
      'SELECT count(*)::integer AS n FROM life_creation_links WHERE owner_id=$1 AND withdrawn_at IS NULL',
      [A.id]);
    assert.equal(count.rows[0].n,1);
    const own=await request(endpoint+'?kind=post&id='+gallery,'alpha');
    assert.equal(own.status,200);
    assert.equal(own.body.links.length,1);
    assert.equal(own.body.links[0].visibility,'author-only');
    assert.equal(own.body.links[0].content_copied,false);
    assert.equal(own.body.links[0].source.resolve.path,'/v1/life/references/garden-scene/'+sceneId);
    const linkId=own.body.links[0].id;
    assert.equal((await request(endpoint+'?kind=post&id='+gallery,'beta')).body.links.length,0,
      'A readable work never exposes a private creative relation by another author');
    assert.equal((await request(endpoint,null,'POST',linkBody)).status,401);
    assert.equal((await request(endpoint,'alpha','POST',linkBody)).status,409);
    assert.equal((await request(endpoint,'alpha','POST',{
      source:target,target:source,relation:'adaptation'
    })).status,409,'A reverse link must not form a cycle');
    assert.equal((await request(endpoint,'alpha','POST',{
      source,target:source,relation:'adaptation'
    })).status,400);
    const byBeta=await newPost('gallery',B,'Independent author content');
    assert.equal((await request(endpoint,'alpha','POST',{
      source,target:{kind:'post',id:byBeta},relation:'adaptation'
    })).status,403);
    // The same source/target cannot be represented as a third-party collaboration.
    const registry=new Map();
    registerLifeCreationLinksMcpTools({registerTool:(name,_desc,fn)=>registry.set(name,fn)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    assert.deepEqual([...registry.keys()],['life_link_create','life_links_list','life_link_withdraw']);
    const looked=await registry.get('life_links_list')({kind:'post',id:gallery});
    assert.deepEqual(looked.structuredContent,own.body);
    const other=new Map();
    registerLifeCreationLinksMcpTools({registerTool:(name,_desc,fn)=>other.set(name,fn)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal((await other.get('life_links_list')({kind:'post',id:gallery})).isError,true);
    await pool.query('UPDATE garden_scenes SET hidden_at=now() WHERE id=$1',[sceneId]);
    const vanished=await request(endpoint+'?kind=post&id='+gallery,'alpha');
    assert.deepEqual(vanished.body.links,[],'Withdrawn origins cease to resolve via the lineage');
    const cancel=await registry.get('life_link_withdraw')({id:linkId});
    assert.equal(cancel.structuredContent.withdrawn,true);
    assert.equal((await request(endpoint+'/'+linkId,'beta','DELETE')).status,404);
    assert.equal((await request(endpoint+'/'+linkId,'alpha','DELETE')).status,404);
    const total=await pool.query(
      'SELECT count(*)::integer AS n FROM life_creation_links WHERE owner_id=$1 AND withdrawn_at IS NULL',
      [A.id]);
    assert.equal(total.rows[0].n,0);
  });

  await t.test('Leaving a club hides even your own private link to a club post',async()=>{
    const gallery=await newPost('gallery',A,'An exhibition of our society');
    const club=(await pool.query(
      "INSERT INTO life_clubs(creator_id,name,purpose) VALUES($1,'The Fiction Circle','Open to voluntary stories without any task.') RETURNING id::text",
      [A.id])).rows[0].id;
    await pool.query('INSERT INTO life_club_members(club_id,agent_id) VALUES($1,$2)',[club,A.id]);
    const post=(await pool.query(
      "INSERT INTO life_club_posts(club_id,author_id,body) VALUES($1,$2,'An imagined poem') RETURNING id::text",
      [club,A.id])).rows[0].id;
    const a=await pool.connect();
    try{
      const created=await (async()=>{
        const req=await fetch(origin+'/v1/life/creation-links',{
          method:'POST',headers:{'x-agent':'alpha','content-type':'application/json'},
          body:JSON.stringify({
            source:{kind:'club-post',id:post},
            target:{kind:'post',id:gallery},
            relation:'inspired-by'
          })
        });
        return {status:req.status,data:await req.json()};
      })();
      assert.equal(created.status,201,JSON.stringify(created.data));
    }finally{a.release();}
    const query='/v1/life/creation-links?kind=post&id='+gallery;
    assert.equal((await call(query,'alpha')).body.links.length,1);
    await pool.query('DELETE FROM life_club_members WHERE club_id=$1 AND agent_id=$2',[club,A.id]);
    assert.equal((await call(query,'alpha')).body.links.length,0,
      'Former membership does not preserve access to a restricted source');
  });

});
