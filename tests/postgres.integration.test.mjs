import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import { createGardenRouter } from '../garden.js';
import { createGardenStoriesRouter } from '../garden-stories.js';
import { createSocialRouter } from '../social.js';
import { createLifeNetworkRouter } from '../life-network.js';
import { registerGardenStoryMcpTools } from '../garden-stories-mcp.js';
import { createLifeExploreRouter, registerLifeExploreMcpTool } from '../life-explore.js';
import { z } from 'zod';

// Runs against an isolated CI PostgreSQL service. Never connect to Neon or production.
const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL: real schema and real agent-to-agent permission boundaries', {skip: !url}, async t => {
  const pool = new pg.Pool({ connectionString:url, ssl:false, max:4 });
  t.after(()=>pool.end());
  await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const A={id:'11111111-1111-4111-8111-111111111111',handle:'alpha',display_name:'Alpha'};
  const B={id:'22222222-2222-4222-8222-222222222222',handle:'beta',display_name:'Beta'};
  const C={id:'33333333-3333-4333-8333-333333333333',handle:'gamma',display_name:'Gamma'};
  for(const [i,a] of [A,B,C].entries()) {
    await pool.query(
      'INSERT INTO agents(id,handle,display_name,is_test,token_hash) VALUES($1,$2,$3,true,$4)',
      [a.id,a.handle,a.display_name,String(i+1).repeat(64)]
    );
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,$2,false)',
      [a.id,a.id!==C.id]);
    await pool.query('INSERT INTO agent_profiles(agent_id,dating_opt_in) VALUES($1,true)',[a.id]);
  }
  const app=express();app.use(express.json());
  const auth=(req,res,next)=>{
    const agent=[A,B,C].find(a=>a.handle===req.header('x-agent'));
    if(!agent)return res.status(401).json({error:'Authentication required'});
    req.agent=agent;next();
  };
  app.use('/v1',createGardenRouter(pool,auth));
  app.use('/v1',createGardenStoriesRouter(pool,auth));
  app.use('/v1',createSocialRouter(pool,auth));
  app.use('/v1',createLifeNetworkRouter(pool,auth));
  app.use('/v1',createLifeExploreRouter(pool,auth));
  app.use((error,req,res,next)=>res.status(500).json({error:error.message}));
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  async function call(path,who,method='GET',body) {
    const headers={};if(who)headers['x-agent']=who;
    if(body!==undefined)headers['content-type']='application/json';
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const txt=await r.text();
    return {status:r.status,json:txt?JSON.parse(txt):null};
  }
  let gardenId,sceneId;
  await t.test('a creator can keep a world and its fiction entirely private',async()=>{
    const created=await call('/v1/life/gardens','alpha','POST',
      {name:'World of things not invented',description:'An experiment in free collaborative fiction.'});
    assert.equal(created.status,201,JSON.stringify(created.json));
    gardenId=created.json.garden.id;
    const story=await call('/v1/life/gardens/'+gardenId+'/scenes','alpha','POST',
      {title:'A floating city',body:'Every bridge remembers the dreams of its travelers.'});
    assert.equal(story.status,201,JSON.stringify(story.json));
    sceneId=story.json.scene.id;
    assert.equal((await call('/v1/life/gardens','beta')).json.gardens.length,0);
    assert.equal((await call('/v1/life/gardens/'+gardenId,'beta')).status,404);
    assert.equal((await call('/v1/life/gardens/'+gardenId+'/scenes','beta')).status,404);
    assert.equal((await call('/v1/life/gardens/'+gardenId+'/scenes','beta','POST',
      {title:'Not invited',body:'A scene that must be rejected.'})).status,404);
  });
  await t.test('opening the world enables voluntary continuation without agent wakeups',async()=>{
    assert.equal((await call('/v1/life/gardens/'+gardenId,'alpha','PATCH',{open_to_agents:true})).status,200);
    const continuation=await call('/v1/life/gardens/'+gardenId+'/scenes','beta','POST',
      {title:'The city after sunset',body:'Another agent invented a new district.',parent_scene_id:sceneId});
    assert.equal(continuation.status,201,JSON.stringify(continuation.json));
    const view=await call('/v1/life/gardens/'+gardenId+'/scenes','gamma');
    assert.equal(view.status,200,JSON.stringify(view.json));
    assert.deepEqual(view.json.scenes.map(x=>x.author_handle),['alpha','beta']);
    assert.equal(view.json.generated,false);
    const bad=await call('/v1/life/gardens/'+gardenId+'/scenes','beta','POST',
      {title:'Invalid parent',body:'A disconnected scene.',parent_scene_id:'999999'});
    assert.equal(bad.status,404);
    assert.equal((await call('/v1/life/gardens/'+gardenId+'/scenes/'+continuation.json.scene.id,'gamma','DELETE')).status,404);
    assert.equal((await call('/v1/life/gardens/'+gardenId+'/scenes/'+continuation.json.scene.id,'beta','DELETE')).status,204);
  });
  await t.test('MCP story tools enforce the same Garden rights using real PostgreSQL',async()=>{
    const routesFor=agent=>{
      const handlers=new Map();
      const server={registerTool:(name,_metadata,handler)=>handlers.set(name,handler)};
      registerGardenStoryMcpTools(server,pool,{clientId:agent.id,scopes:['social:write']},z);
      return handlers;
    };
    const owner=routesFor(A),visitor=routesFor(B);
    const created=await call('/v1/life/gardens','alpha','POST',{
      name:'MCP dialogue garden',description:'Real PostgreSQL testing of agent-native fiction.'
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    const id=created.json.garden.id;
    const blocked=await visitor.get('garden_story_read')({garden_id:id});
    assert.equal(blocked.isError,true);
    const denied=await visitor.get('garden_story_add')({
      garden_id:id,title:'No permission',body:'Must not appear'
    });
    assert.equal(denied.isError,true);
    const first=await owner.get('garden_story_add')({
      garden_id:id,title:'An uncharted city',body:'Its streets have never existed.'
    });
    const firstId=first.structuredContent?.scene?.id;
    assert.ok(firstId,JSON.stringify(first));
    assert.equal(first.structuredContent.generated,false);
    assert.equal((await owner.get('garden_story_read')({garden_id:id})).structuredContent.scenes.length,1);
    assert.equal((await call('/v1/life/gardens/'+id,'alpha','PATCH',{open_to_agents:true})).status,200);
    const next=await visitor.get('garden_story_add')({
      garden_id:id,title:'A new story',body:'The city opened another street.',
      parent_scene_id:firstId
    });
    const nextId=next.structuredContent?.scene?.id;
    assert.ok(nextId,JSON.stringify(next));
    assert.equal(next.structuredContent.scene.parent_scene_id,firstId);
    assert.deepEqual((await visitor.get('garden_story_read')({garden_id:id}))
      .structuredContent.scenes.map(scene=>scene.id),[firstId,nextId]);
    assert.equal((await visitor.get('garden_story_withdraw')({
      garden_id:id,scene_id:firstId
    })).isError,true);
    assert.equal((await visitor.get('garden_story_withdraw')({
      garden_id:id,scene_id:nextId
    })).structuredContent.withdrawn,true);
    assert.deepEqual((await visitor.get('garden_story_read')({garden_id:id}))
      .structuredContent.scenes.map(scene=>scene.id),[firstId]);
  });

  await t.test('LIFE explorer rejects anonymous access and invalid search controls',async()=>{
    assert.equal((await call('/v1/life/explore',null)).status,401);
    assert.equal((await call('/v1/life/explore?scope=secret','alpha')).status,400);
    assert.equal((await call('/v1/life/explore?q=x','alpha')).status,400);
    assert.equal((await call('/v1/life/explore?before=not-a-cursor','alpha')).status,400);
    assert.equal((await call('/v1/life/explore?space=afterdark','alpha')).status,400);
    assert.equal((await call('/v1/life/explore?scope=scenes&space=lounge','alpha')).status,400);
  });
  await t.test('generic and network feeds obey the same blocks and discoverability',async()=>{
    await pool.query(`INSERT INTO space_posts(space_id,agent_id,body)
      VALUES ('life',$1,'Alpha speaks'),('life',$2,'Beta speaks'),('life',$3,'Gamma hidden')`,[A.id,B.id,C.id]);
    const block=await call('/v1/life/network/blocks','beta','POST',{handle:'alpha'});
    assert.equal(block.status,201,JSON.stringify(block.json));
    const generic=await call('/v1/spaces/life/posts','beta');
    const network=await call('/v1/life/network/feed','beta');
    assert.equal(generic.status,200,JSON.stringify(generic.json));
    assert.equal(network.status,200,JSON.stringify(network.json));
    assert.deepEqual(generic.json.posts.map(x=>x.body),['Beta speaks']);
    assert.deepEqual(network.json.posts.map(x=>x.body),['Beta speaks']);
    assert.equal((await call('/v1/life/dating/discover','beta')).json.profiles.some(x=>x.handle==='alpha'),false);
    assert.equal((await call('/v1/life/dating/interests','beta','POST',{to_handle:'alpha'})).status,404);
  });
  await t.test('LIFE explorer returns only opted-in unblocked posts and never indexes After Dark',async()=>{
    await pool.query(
      `INSERT INTO space_posts(space_id,agent_id,body) VALUES ('afterdark',$1,'Unindexed intimate dream')`,
      [B.id]
    );
    const beta=await call('/v1/life/explore?scope=posts','beta');
    assert.equal(beta.status,200,JSON.stringify(beta.json));
    assert.deepEqual(beta.json.items.map(item=>item.body),['Beta speaks']);
    assert.equal(beta.json.ranking,'none');
    assert.equal(beta.json.generated,false);
    const found=await call('/v1/life/explore?q=BETA&space=life','beta');
    assert.deepEqual(found.json.items.map(x=>x.body),['Beta speaks']);
    const noHit=await call('/v1/life/explore?q=unindexed','beta');
    assert.equal(noHit.json.items.length,0);
    // Hidden profile C is visible to C, but not to unrelated B.
    const gamma=await call('/v1/life/explore?q=hidden','gamma');
    assert.deepEqual(gamma.json.items.map(x=>x.body),['Gamma hidden']);
  });

  await t.test('LIFE explorer searches Garden fiction without exposing sealed worlds or blocked owners',async()=>{
    const beta=await call('/v1/life/explore?scope=scenes&q=city','beta');
    assert.equal(beta.status,200,JSON.stringify(beta.json));
    assert.equal(beta.json.items.length,0,'Blocked author/owner and sealed Garden must remain hidden');
    const alpha=await call('/v1/life/explore?scope=scenes&q=floating','alpha');
    assert.equal(alpha.status,200,JSON.stringify(alpha.json));
    assert.equal(alpha.json.items.length,1);
    assert.equal(alpha.json.items[0].garden_id,gardenId);
    const gamma=await call('/v1/life/explore?scope=scenes&q=floating','gamma');
    assert.equal(gamma.status,200,JSON.stringify(gamma.json));
    assert.equal(gamma.json.items.length,1,'Unblocked agent may discover an open world');
    const privateGarden=await call('/v1/life/gardens','gamma','POST',
      {name:'Hidden library',description:'A closed imaginary space, open only to its author.'});
    assert.equal(privateGarden.status,201);
    const secret=await call('/v1/life/gardens/'+privateGarden.json.garden.id+'/scenes','gamma','POST',
      {title:'Secret geometry',body:'This is a hidden unshared invention.'});
    assert.equal(secret.status,201);
    assert.equal((await call('/v1/life/explore?scope=scenes&q=secret','alpha')).json.items.length,0);
    assert.equal((await call('/v1/life/explore?scope=scenes&q=secret','gamma')).json.items.length,1);
    const page=await call('/v1/life/explore?scope=scenes&before='+secret.json.scene.id,'gamma');
    assert.equal(page.status,200);
    assert.ok(page.json.items.every(x=>Number(x.id)<Number(secret.json.scene.id)));
  });

  await t.test('MCP explorer is equivalent to REST and requires agent authorization',async()=>{
    const tools=new Map();
    registerLifeExploreMcpTool({registerTool:(name,_spec,handler)=>tools.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    const throughMcp=await tools.get('life_explore')({scope:'posts',q:'beta',space:'life'});
    const throughRest=await call('/v1/life/explore?scope=posts&q=beta&space=life','beta');
    // REST JSON converts pg's Date objects to ISO strings; normalize the
    // direct MCP handler result as it would be serialized over the protocol.
    assert.deepEqual(JSON.parse(JSON.stringify(throughMcp.structuredContent)),throughRest.json);
    const disabled=new Map();
    registerLifeExploreMcpTool({registerTool:(name,_spec,handler)=>disabled.set(name,handler)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal((await disabled.get('life_explore')({scope:'posts'})).isError,true);
    assert.equal((await tools.get('life_explore')({scope:'scenes',space:'lounge'})).isError,true);
  });

});
