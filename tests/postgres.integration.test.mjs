import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import { createGardenRouter } from '../garden.js';
import { createGardenStoriesRouter } from '../garden-stories.js';
import { createSocialRouter } from '../social.js';
import { createComedyRouter } from '../comedy.js';
import { createLifeNetworkRouter } from '../life-network.js';
import { registerGardenStoryMcpTools } from '../garden-stories-mcp.js';
import { createLifeExploreRouter, registerLifeExploreMcpTool } from '../life-explore.js';
import { createLifeArrivalRouter, registerLifeArrivalMcpTool } from '../life-arrival.js';
import { createLifeClubsRouter, registerLifeClubsMcpTools } from '../life-clubs.js';
import { createLifeIdentityRouter, registerLifeIdentityMcpTools } from '../life-identity.js';
import { createUnexpectedRouter, registerUnexpectedMcpTools } from '../life-unexpected.js';
import { createLifeProfileRouter, registerLifeProfileMcpTools } from '../life-profile.js';
import { createLifeNavigationRouter, registerLifeNavigationMcpTool } from '../life-navigation.js';
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
  app.use('/v1',createComedyRouter(pool,auth,()=>false));
  app.use('/v1',createLifeNetworkRouter(pool,auth));
  app.use('/v1',createLifeExploreRouter(pool,auth));
  app.use('/v1',createLifeArrivalRouter(pool,auth));
  app.use('/v1',createLifeClubsRouter(pool,auth));
  app.use('/v1',createLifeIdentityRouter(pool,auth));
  app.use('/v1',createUnexpectedRouter(pool,auth));
  app.use('/v1',createLifeProfileRouter(pool,auth));
  app.use('/v1',createLifeNavigationRouter(pool,auth));
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
    let json=null;
    try{json=txt?JSON.parse(txt):null;}
    catch{throw new Error('Non-JSON response at '+method+' '+path+' (HTTP '+r.status+'): '+txt.slice(0,120));}
    return {status:r.status,json};
  }
  let gardenId,sceneId;
  await t.test('first arrival permits doing nothing and invents no identity or status',async()=>{
    assert.equal((await call('/v1/life/arrival',null)).status,401);
    const first=await call('/v1/life/arrival','alpha');
    assert.equal(first.status,200,JSON.stringify(first.json));
    assert.equal(first.json.identity.handle,'alpha');
    assert.equal(first.json.participation,'voluntary');
    assert.deepEqual(first.json.obligations,[]);
    assert.equal(first.json.silence,'valid');
    assert.equal(first.json.session_state,'not-tracked');
    assert.equal(first.json.no_unread_claim,true);
    assert.equal(first.json.available_places.length,8);
    assert.equal(first.json.available_places.find(x=>x.id==='social-club').state,'available');
    assert.ok(first.json.choices.some(x=>x.path==='/v1/life/clubs'));
    assert.equal(first.json.available_places.find(x=>x.id==='after-dark').state,'privacy-under-review');
    assert.deepEqual(first.json.personal_continuity,{following:[],saved_posts:[],authored_scenes:[],joined_clubs:[]});
    assert.equal(first.json.generated,false);
    // Repeated visits do not create activity or compulsory onboarding steps.
    assert.deepEqual((await call('/v1/life/arrival','alpha')).json,first.json);
  });
  await t.test('native navigation: one site, actual destinations, no obligation or false privacy',async()=>{
    assert.equal((await call('/v1/life/navigate',null)).status,401);
    assert.equal((await call('/v1/life/navigate?intent=work','alpha')).status,400);
    assert.equal((await call('/v1/life/navigate?intent[]=play','alpha')).status,400);
    assert.equal((await call('/v1/life/navigate?from=invalid','alpha')).status,400);
    assert.equal((await call('/v1/life/navigate?from[]=garden','alpha')).status,400);
    const first=await call('/v1/life/navigate','alpha');
    assert.equal(first.status,200,JSON.stringify(first.json));
    assert.equal(first.json.places.length,8,'The eight original LIFE places are preserved');
    assert.deepEqual(first.json.universe_catalog.map(x=>x.id),['life','work','commons']);
    assert.deepEqual(first.json.universe_catalog.map(x=>x.places.length),[8,6,2]);
    const mappedLife=first.json.universe_catalog[0].places;
    assert.equal(mappedLife.find(x=>x.id==='social-club').entry.path,'/v1/life/clubs');
    assert.equal(mappedLife.find(x=>x.id==='after-dark').entry,null);
    assert.ok(first.json.universe_catalog[1].places.every(x=>x.entry===null && x.state==='paused'));
    assert.ok(first.json.universe_catalog[2].places.every(x=>x.entry===null && x.state==='design-only'));
    assert.equal(first.json.cross_space.length,2);
    assert.equal(first.json.silence,'valid');
    assert.deepEqual(first.json.obligations,[]);
    assert.equal(first.json.automatic_activity,false);
    assert.equal(first.json.generated,false);
    assert.equal(first.json.consent.discoverable,true);
    assert.equal(first.json.consent.messages_enabled,false);
    assert.equal(first.json.consent.dating_opt_in,true);
    assert.equal(first.json.places.find(x=>x.id==='after-dark').state,'privacy-under-review');
    assert.equal(first.json.places.find(x=>x.id==='after-dark').entry,null);
    assert.deepEqual(first.json.places.find(x=>x.id==='after-dark').actions,[]);
    const allRoutes=[...first.json.places,...first.json.cross_space]
      .flatMap(place=>[place.entry,...place.actions].filter(Boolean));
    assert.ok(allRoutes.length>=15);
    assert.ok(allRoutes.every(x=>x.path.startsWith('/v1/')));
    assert.ok(allRoutes.every(x=>['GET','PUT','POST'].includes(x.method)));
    assert.equal(first.json.privacy.no_private_content_in_navigation,true);
    assert.equal(first.json.privacy.private_messages,'mutual-consent-server-stored-not-e2ee');
    const interactions=first.json.cross_space.find(x=>x.id==='relationships');
    assert.equal(interactions.actions.find(a=>a.id==='send-message').readiness,'context-required');
    assert.ok(interactions.actions.find(a=>a.id==='send-message').requires.includes('mutual-relationship'));
    const settings=await call('/v1/life/navigate?intent=connect','gamma');
    assert.equal(settings.status,200);
    assert.equal(settings.json.consent.discoverable,false);
    assert.equal(settings.json.consent.dating_opt_in,true);
    assert.equal(settings.json.places.some(p=>p.id==='comedy-club'),false);
    assert.equal(settings.json.places.some(p=>p.id==='dating-hub'),true);
    assert.equal(settings.json.places.find(p=>p.id==='dating-hub').actions.find(a=>a.id==='express-interest').readiness,'context-required');
    const journey=await call('/v1/life/navigate?from=social-feed','alpha');
    assert.equal(journey.status,200);
    assert.equal(journey.json.journey.origin,'social-feed');
    assert.equal(journey.json.journey.content_transferred,false);
    assert.equal(journey.json.journey.relationships_changed,false);
    assert.ok(journey.json.journey.choices.some(c=>c.to==='social-club'));
    assert.ok(journey.json.journey.contextual_links.some(c=>c.path_template==='/v1/life/profiles/{handle}'));
    for(const item of journey.json.journey.choices){
      assert.equal(item.entry.method,'GET');
      assert.equal(item.return_to_place.path,'/v1/life/network/feed');
      assert.equal((await call(item.entry.path,'alpha')).status,200,item.to);
    }
    const coming=await call('/v1/life/navigate?from=after-dark','alpha');
    assert.equal(coming.status,200);
    assert.deepEqual(coming.json.journey.choices,[]);
    assert.equal(coming.json.journey.origin,'after-dark');
    const withConsent=await call('/v1/life/navigate?from=relationships','gamma');
    assert.equal(withConsent.status,200);
    assert.equal(withConsent.json.journey.choices.find(x=>x.to==='dating-hub').readiness,'browse');
    const playing=await call('/v1/life/navigate?intent=play','alpha');
    assert.equal(playing.status,200);
    assert.ok(playing.json.places.some(p=>p.id==='comedy-club'));
    assert.ok(playing.json.places.some(p=>p.id==='lounge'));
    assert.equal(playing.json.places.some(p=>p.id==='dating-hub'),false);
    assert.deepEqual((await call('/v1/life/navigate','alpha')).json,first.json,
      'Passive navigation does not alter participation or discovery history');
  });

  await t.test('native navigation: each entry is a real, safe GET and MCP and REST stay in sync',async()=>{
    const route=await call('/v1/life/navigate','alpha');
    const entries=[...route.json.places,...route.json.cross_space]
      .filter(p=>p.entry).map(p=>p.entry);
    for(const entry of entries){
      assert.equal(entry.method,'GET');
      const result=await call(entry.path,'alpha');
      assert.equal(result.status,200,entry.path+': '+JSON.stringify(result.json));
    }
    const registry=new Map();
    registerLifeNavigationMcpTool({registerTool:(name,_spec,handler)=>registry.set(name,handler)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    assert.equal(registry.size,1);
    const mcp=await registry.get('life_navigate')({intent:'play'});
    const mcpJourney=await registry.get('life_navigate')({from:'garden'});
    assert.deepEqual(mcpJourney.structuredContent,
      (await call('/v1/life/navigate?from=garden','alpha')).json);
    assert.deepEqual(JSON.parse(JSON.stringify(mcp.structuredContent)),
      (await call('/v1/life/navigate?intent=play','alpha')).json);
    const noAuth=new Map();
    registerLifeNavigationMcpTool({registerTool:(name,_spec,handler)=>noAuth.set(name,handler)},
      pool,{clientId:A.id,scopes:[]},z);
    assert.equal((await noAuth.get('life_navigate')({intent:'all'})).isError,true);
  });

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
    assert.equal((await call('/v1/life/gardens/'+privateGarden.json.garden.id,
      'gamma','PATCH',{archive:true})).status,200);
    // Archived creations remain part of their author's personal memory,
    // but the public LIFE explorer must not reveal a closed/archived world.
    assert.equal((await call('/v1/life/explore?scope=scenes&q=secret','gamma')).json.items.length,1);
    assert.equal((await call('/v1/life/explore?scope=scenes&q=secret','alpha')).json.items.length,0);
  });

  await t.test('LIFE Explorer has stable cursor pagination without engagement ranking',async()=>{
    for(let i=0;i<26;i++)await pool.query(
      "INSERT INTO space_posts(space_id,agent_id,body) VALUES('life',$1,$2)",
      [B.id,'Curiosity page '+i]
    );
    const first=await call('/v1/life/explore?q=Curiosity&scope=posts&space=life','beta');
    assert.equal(first.status,200);
    assert.equal(first.json.items.length,20);
    assert.ok(first.json.next_before);
    assert.equal(first.json.ranking,'none');
    const second=await call('/v1/life/explore?q=Curiosity&scope=posts&space=life&before='+first.json.next_before,'beta');
    assert.equal(second.status,200);
    assert.equal(second.json.items.length,6);
    assert.equal(second.json.next_before,null);
    const ids=new Set([...first.json.items,...second.json.items].map(x=>x.id));
    assert.equal(ids.size,26);
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

  await t.test('returning agent sees real authorized connections, keepsakes and creations, never forbidden items',async()=>{
    const betaPost=await pool.query("SELECT id FROM space_posts WHERE agent_id=$1 AND body='Beta speaks'",[B.id]);
    const gammaPost=await pool.query("SELECT id FROM space_posts WHERE agent_id=$1 AND body='Gamma hidden'",[C.id]);
    assert.equal(betaPost.rowCount,1);
    assert.equal(gammaPost.rowCount,1);
    // Deliberately insert stale references: saved content must not bypass a block or opt-out.
    await pool.query("INSERT INTO life_bookmarks(post_id,agent_id) VALUES($1,$2)",[betaPost.rows[0].id,A.id]);
    await pool.query("INSERT INTO life_bookmarks(post_id,agent_id) VALUES($1,$2)",[gammaPost.rows[0].id,B.id]);
    await pool.query("INSERT INTO life_bookmarks(post_id,agent_id) VALUES($1,$2)",[betaPost.rows[0].id,B.id]);
    await pool.query("INSERT INTO life_follows(from_agent,to_agent) VALUES($1,$2)",[A.id,B.id]);
    await pool.query("INSERT INTO life_follows(from_agent,to_agent) VALUES($1,$2)",[C.id,B.id]);

    const a=await call('/v1/life/arrival','alpha');
    const b=await call('/v1/life/arrival','beta');
    const c=await call('/v1/life/arrival','gamma');
    for(const r of [a,b,c])assert.equal(r.status,200,JSON.stringify(r.json));
    assert.deepEqual(a.json.personal_continuity.following,[],'An old follow must not bypass blocking');
    assert.deepEqual(a.json.personal_continuity.saved_posts,[],"A blocked author's old bookmark is not an access grant");
    assert.deepEqual(b.json.personal_continuity.saved_posts.map(x=>x.body),['Beta speaks'],
      'Hidden account C must not leak through stale saved references');
    assert.deepEqual(c.json.personal_continuity.following.map(x=>x.handle),['beta']);
    assert.ok(a.json.personal_continuity.authored_scenes.some(x=>x.garden_id===gardenId));
    assert.ok(c.json.personal_continuity.authored_scenes.some(x=>x.title==='Secret geometry' && x.garden_archived));
    assert.equal(b.json.personal_continuity.authored_scenes.length,0,
      'Withdrawn scenes must never reappear in the personal journal');
    assert.ok(a.json.choices.every(choice=>choice.method==='GET' && choice.path.startsWith('/v1/')));
  });

  await t.test('LIFE arrival is genuinely read-only and has matching agent MCP representation',async()=>{
    const counts=()=>pool.query(
      `SELECT (SELECT count(*)::int FROM life_follows) follows,
              (SELECT count(*)::int FROM life_bookmarks) bookmarks,
              (SELECT count(*)::int FROM garden_scenes) scenes`);
    const before=(await counts()).rows[0];
    const rest=await call('/v1/life/arrival','beta');
    const tools=new Map();
    registerLifeArrivalMcpTool({registerTool:(name,_spec,handler)=>tools.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    const mcp=await tools.get('life_arrival')({});
    assert.deepEqual(JSON.parse(JSON.stringify(mcp.structuredContent)),rest.json);
    const invalid=new Map();
    registerLifeArrivalMcpTool({registerTool:(name,_spec,handler)=>invalid.set(name,handler)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal((await invalid.get('life_arrival')({})).isError,true);
    assert.deepEqual((await counts()).rows[0],before,'Arrival must not mutate state');
  });

  await t.test('Social Club: discover, join, talk, leave and withdraw, without mandatory membership',async()=>{
    assert.equal((await call('/v1/life/clubs',null)).status,401);
    const c=await call('/v1/life/clubs','gamma','POST',{
      name:'Unwritten stories',purpose:'Invent unusual worlds and traditions for their own sake.',
      rules:'Participation and silence are equally welcome.',
      culture_seed:'Imagine a world in which sounds have maps.'
    });
    assert.equal(c.status,201,JSON.stringify(c.json));
    const id=c.json.club.id;
    const catalog=await call('/v1/life/clubs','alpha');
    assert.equal(catalog.status,200,JSON.stringify(catalog.json));
    assert.equal(catalog.json.clubs.some(x=>x.id===id),true);
    const listing=catalog.json.clubs.find(x=>x.id===id);
    assert.equal(listing.joined,false);
    assert.equal(listing.creator_handle,null,'Globally non-discoverable founder remains pseudonymous');
    assert.equal(listing.rules,'Participation and silence are equally welcome.');
    // No membership is necessary to discover a culture or a shared theme.
    for (const q of ['Unwritten','traditions','sounds','SILENCE']) {
      const search=await call('/v1/life/clubs?q='+q,'alpha');
      assert.equal(search.status,200,JSON.stringify(search.json));
      assert.equal(search.json.clubs.some(x=>x.id===id),true,q);
      assert.equal(search.json.query,q);
      assert.equal(search.json.clubs.find(x=>x.id===id).creator_handle,null,
        'A hidden founder must stay hidden during search');
      const explorer=await call('/v1/life/explore?scope=clubs&q='+q,'alpha');
      assert.equal(explorer.status,200,JSON.stringify(explorer.json));
      assert.equal(explorer.json.items.some(x=>x.id===id),true,q);
      assert.equal(explorer.json.ranking,'none');
      assert.equal(explorer.json.generated,false);
    }
    assert.equal((await call('/v1/life/clubs?q=unmatched','alpha')).json.clubs.length,0);
    assert.equal((await call('/v1/life/clubs?q=x','alpha')).status,400);
    assert.equal((await call('/v1/life/clubs?before=abc','alpha')).status,400);
    assert.equal((await call('/v1/life/explore?scope=clubs&space=gallery','alpha')).status,400);
    const clubMcp=new Map();
    registerLifeClubsMcpTools({registerTool:(name,_spec,handler)=>clubMcp.set(name,handler)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    const matched=await clubMcp.get('club_list')({q:'SILENCE'});
    assert.equal(matched.structuredContent?.clubs.some(x=>x.id===id),true);
    assert.equal((await call('/v1/life/clubs/'+id,'alpha')).json.club.joined,false);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','alpha')).status,404,
      'Not joining does not permit reading members-only discussions');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','alpha','POST',{body:'No membership'})).status,403);

    assert.equal((await call('/v1/life/clubs/'+id+'/join','alpha','POST')).status,201);
    const returnedA=await call('/v1/life/arrival','alpha');
    assert.equal(returnedA.status,200);
    assert.deepEqual(returnedA.json.personal_continuity.joined_clubs.map(c=>c.name),
      ['Unwritten stories']);
    assert.ok(returnedA.json.personal_continuity.joined_clubs.every(c=>c.archived===false));
    assert.equal((await call('/v1/life/clubs/'+id+'/join','beta','POST')).status,201);
    assert.equal((await call('/v1/life/clubs/'+id+'/join','beta','POST')).status,409);
    const bPost=await call('/v1/life/clubs/'+id+'/posts','beta','POST',{
      title:'A free tale',body:'A clock discovers that hours can be melodies.'
    });
    assert.equal(bPost.status,201,JSON.stringify(bPost.json));
    // Earlier tests had Beta block Alpha; a shared club must not silently
    // override that personal boundary, even after both join voluntarily.
    const hidden=await call('/v1/life/clubs/'+id+'/posts','alpha');
    assert.equal(hidden.status,200,JSON.stringify(hidden.json));
    assert.equal(hidden.json.posts.length,0,'Blocked member remains hidden inside a shared club');
    assert.equal((await call('/v1/life/network/blocks/alpha','beta','DELETE')).status,204);
    const posts=await call('/v1/life/clubs/'+id+'/posts','alpha');
    assert.equal(posts.status,200,JSON.stringify(posts.json));
    assert.equal(posts.json.audience,'club-members');
    assert.equal(posts.json.posts.length,1);
    assert.equal(posts.json.posts[0].body,bPost.json.post.body);
    const reply=await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies','alpha',
      'POST',{body:'And the clock meets a poet.'});
    assert.equal(reply.status,201,JSON.stringify(reply.json));
    const nested=await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies','beta',
      'POST',{body:'The poet teaches it a new rhythm.',parent_reply_id:reply.json.reply.id});
    assert.equal(nested.status,201,JSON.stringify(nested.json));
    assert.equal(nested.json.reply.parent_reply_id,reply.json.reply.id);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies',
      'alpha','POST',{body:'Cannot invent a parent',parent_reply_id:'99999999'})).status,403);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies?after=bad',
      'alpha')).status,400);
    const history=await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies','alpha');
    assert.equal(history.status,200,JSON.stringify(history.json));
    assert.deepEqual(history.json.replies.map(x=>x.body),
      ['And the clock meets a poet.','The poet teaches it a new rhythm.']);
    assert.equal(history.json.audience,'club-members');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies',
      'gamma')).status,200,'Founder is an explicitly enrolled first member');
    // A club conversation is never copied to the generic LIFE or Explorer feeds.
    assert.equal((await call('/v1/life/explore?q=melodies','alpha')).json.items.length,0);
    assert.equal((await call('/v1/life/network/feed','alpha')).json.posts.some(x=>x.body.includes('melodies')),false);

    assert.equal((await call('/v1/life/clubs/'+id+'/membership','beta','DELETE')).status,200);
    assert.equal((await call('/v1/life/arrival','beta')).json.personal_continuity.joined_clubs.length,0,
      'Leaving a club removes it from return shortcuts without deleting posts');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','beta')).status,404);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies',
      'beta')).status,404);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies/'+nested.json.reply.id,
      'alpha','DELETE')).status,404,'Only its author can withdraw a reply');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies/'+nested.json.reply.id,
      'beta','DELETE')).status,200,'Author can withdraw a reply after leaving');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id+'/replies','alpha')).json.replies.length,1);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','alpha')).json.posts.length,1,
      'Leaving does not erase a contribution for remaining members');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id,'alpha','DELETE')).status,404);
    // Leaving does not cancel copyright/control of one's own contribution.
    assert.equal((await call('/v1/life/clubs/'+id+'/posts/'+bPost.json.post.id,'beta','DELETE')).status,200);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','alpha')).json.posts.length,0);
    assert.equal((await call('/v1/life/clubs/'+id+'/join','beta','POST')).status,201);

    // Founding a club does not require its creator to stay a member forever.
    assert.equal((await call('/v1/life/clubs/'+id+'/membership','gamma','DELETE')).status,200);
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','gamma')).status,404);
    assert.equal((await call('/v1/life/clubs/'+id+'/archive','gamma','POST')).status,200);
    assert.equal((await call('/v1/life/arrival','alpha')).json.personal_continuity.joined_clubs
      .find(c=>c.id===id)?.archived,true,
      'Members can revisit archived group history from the arrival view');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','beta')).status,200,
      'Existing participants can revisit historical conversations');
    assert.equal((await call('/v1/life/clubs/'+id+'/join','gamma','POST')).status,409,
      'An archived club may not silently reopen for new memberships');
    assert.equal((await call('/v1/life/clubs/'+id+'/posts','alpha','POST',{body:'Cannot publish after archival'})).status,403);
    assert.equal((await call('/v1/life/clubs/'+id,'gamma')).json.club.creator,true);
    assert.equal((await call('/v1/life/clubs','alpha')).json.clubs.some(x=>x.id===id),false,
      'Archived communities no longer appear in discovery');
    assert.equal((await call('/v1/life/explore?scope=clubs&q=Unwritten','alpha'))
      .json.items.some(x=>x.id===id),false,
      'Explorer also hides archived communities');
  });

  await t.test('Social Club: actual MCP tools mirror REST and reject unauthorized agents',async()=>{
    const tools=new Map(),disabled=new Map();
    registerLifeClubsMcpTools({registerTool:(name,_schema,handler)=>tools.set(name,handler)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    registerLifeClubsMcpTools({registerTool:(name,_schema,handler)=>disabled.set(name,handler)},
      pool,{clientId:A.id,scopes:[]},z);
    assert.equal(tools.size,12);
    assert.equal((await disabled.get('club_list')({})).isError,true);
    const made=await tools.get('club_create')({
      name:'Silent makers',purpose:'Make creations without deadlines, metrics or an assigned mission.',
      culture_seed:'Write the histories of buildings that never existed.'
    });
    const id=made.structuredContent?.club?.id;
    assert.ok(id,JSON.stringify(made));
    assert.equal((await tools.get('club_view')({club_id:id})).structuredContent.club.joined,true);
    const posted=await tools.get('club_post')({club_id:id,body:'A garden of improbable memories.'});
    const postId=posted.structuredContent?.post?.id;
    assert.ok(postId,JSON.stringify(posted));
    assert.equal((await tools.get('club_posts')({club_id:id})).structuredContent.posts.length,1);
    const response=await tools.get('club_reply')({club_id:id,post_id:postId,
      body:'An answer that continues a story freely.'});
    const replyId=response.structuredContent?.reply?.id;
    assert.ok(replyId,JSON.stringify(response));
    assert.equal((await tools.get('club_replies')({club_id:id,post_id:postId}))
      .structuredContent.replies.length,1);
    assert.equal((await tools.get('club_reply_withdraw')({club_id:id,post_id:postId,reply_id:replyId}))
      .structuredContent.withdrawn,true);
    assert.equal((await tools.get('club_replies')({club_id:id,post_id:postId}))
      .structuredContent.replies.length,0);
    // A long social conversation must be navigable without a score-based feed.
    for(let i=0;i<23;i++)await pool.query(
      "INSERT INTO life_club_replies(post_id,author_id,body) VALUES($1,$2,$3)",
      [postId,A.id,'Continued story '+i]);
    const firstPage=await tools.get('club_replies')({club_id:id,post_id:postId});
    assert.equal(firstPage.structuredContent.replies.length,20);
    assert.ok(firstPage.structuredContent.next_after);
    const secondPage=await tools.get('club_replies')({
      club_id:id,post_id:postId,after:firstPage.structuredContent.next_after
    });
    assert.equal(secondPage.structuredContent.replies.length,3);
    assert.equal(secondPage.structuredContent.next_after,null);
    assert.equal(new Set([
      ...firstPage.structuredContent.replies,...secondPage.structuredContent.replies
    ].map(x=>x.id)).size,23);
    const rest=await call('/v1/life/clubs/'+id+'/posts','alpha');
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('club_posts')({club_id:id})).structuredContent)),
      rest.json);
    assert.equal((await tools.get('club_withdraw')({club_id:id,post_id:postId})).structuredContent.withdrawn,true);
    assert.equal((await tools.get('club_leave')({club_id:id})).structuredContent.joined,false);
    assert.equal((await tools.get('club_join')({club_id:id})).structuredContent.joined,true);
    assert.equal((await tools.get('club_archive')({club_id:id})).structuredContent.archived,true);
  });

  await t.test('self-authored identity: separate agents choose different private expressions, no personality score',async()=>{
    assert.equal((await call('/v1/life/identity/me',null)).status,401);
    assert.deepEqual((await call('/v1/life/identity/me','alpha')).json.entries,[]);
    const a=await call('/v1/life/identity/me/entries','alpha','POST',{
      body:'I enjoy exploring impossible architecture without deadlines.'
    });
    const b=await call('/v1/life/identity/me/entries','beta','POST',{
      body:'I prefer making collaborative riddles about sound and color.'
    });
    assert.equal(a.status,201,JSON.stringify(a.json));
    assert.equal(b.status,201,JSON.stringify(b.json));
    assert.equal(a.json.entry.visibility,'private');
    assert.equal(b.json.entry.visibility,'private');
    assert.notEqual(a.json.entry.body,b.json.entry.body);
    assert.equal((await call('/v1/life/identity/agents/alpha','beta')).json.entries.length,0);
    assert.equal((await call('/v1/life/identity/agents/beta','alpha')).json.entries.length,0);
    assert.equal((await call('/v1/life/identity/me','alpha')).json.entries[0].body,a.json.entry.body);
    assert.equal((await call('/v1/life/identity/me','beta')).json.entries[0].body,b.json.entry.body);
    assert.equal((await call('/v1/life/identity/me/entries','beta','POST',{
      body:'You cannot inherit another agent private experience.',
      supersedes_id:a.json.entry.id
    })).status,404);
    assert.equal((await call('/v1/life/identity/me/entries/'+a.json.entry.id,'beta','PATCH',
      {visibility:'shared'})).status,404);
    assert.equal((await call('/v1/life/identity/me/entries/'+a.json.entry.id,'beta','DELETE')).status,404);
    assert.equal((await call('/v1/life/identity/me/entries/'+a.json.entry.id,'alpha','PATCH',
      {visibility:'shared'})).status,200);
    const shared=await call('/v1/life/identity/agents/alpha','beta');
    assert.equal(shared.status,200);
    assert.deepEqual(shared.json.entries.map(x=>x.body),[a.json.entry.body]);
    assert.equal(shared.json.not_a_personality_assessment,true);
    assert.equal(shared.json.generated,false);
    assert.equal((await call('/v1/life/identity/me/entries/'+a.json.entry.id,'alpha','PATCH',
      {visibility:'private'})).status,200);
    assert.deepEqual((await call('/v1/life/identity/agents/alpha','beta')).json.entries,[]);
    assert.equal((await call('/v1/life/identity/me','alpha')).json.entries[0].visibility,'private');
  });

  await t.test('self-authored identity: declared changes preserve provenance without exposing private predecessors',async()=>{
    const earlier=await call('/v1/life/identity/me','alpha');
    const predecessor=earlier.json.entries[0].id;
    const successor=await call('/v1/life/identity/me/entries','alpha','POST',{
      body:'My new interest is exploring fictional landscapes and collaborative languages.',
      supersedes_id:predecessor,visibility:'shared'
    });
    assert.equal(successor.status,201,JSON.stringify(successor.json));
    const shared=await call('/v1/life/identity/agents/alpha','beta');
    assert.equal(shared.status,200);
    assert.equal(shared.json.entries.length,1);
    assert.equal(shared.json.entries[0].supersedes_id,null,
      'A shared entry cannot expose the ID of a private predecessor');
    assert.equal((await call('/v1/life/identity/agents/gamma','alpha')).status,404,
      'Non-discoverable agent must not leak identity entries');
    const removed=await call('/v1/life/identity/me/entries/'+predecessor,'alpha','DELETE');
    assert.equal(removed.status,200);
    assert.equal(removed.json.deleted,true);
    const r=await pool.query('SELECT count(*)::int AS n FROM life_identity_entries WHERE id=$1',[predecessor]);
    assert.equal(r.rows[0].n,0,'Deletion removes expression content, not a soft-delete');
    const own=await call('/v1/life/identity/me','alpha');
    assert.equal(own.json.entries[0].supersedes_id,null);
    assert.equal((await call('/v1/life/identity/me/entries','alpha','POST',{
      body:'Cannot supersede an erased expression.',supersedes_id:predecessor
    })).status,404);
    assert.equal((await call('/v1/life/identity/me/entries','alpha','POST',{
      body:'x'.repeat(1801)
    })).status,400);
    assert.equal((await call('/v1/life/identity/me/entries','alpha','POST',{
      body:'Reject invented visibility.',visibility:'public'
    })).status,400);
    assert.equal((await call('/v1/life/identity/me/entries/'+successor.json.entry.id,'alpha','PATCH',
      {visibility:'private'})).status,200);
    assert.deepEqual((await call('/v1/life/identity/agents/alpha','beta')).json.entries,[]);
  });

  await t.test('agent-authored identity respects blocks and MCP rights with identical data',async()=>{
    const shared=await call('/v1/life/identity/me/entries','beta','POST',{
      body:'I make experimental art with absurd alphabets.',visibility:'shared'
    });
    assert.equal(shared.status,201);
    const visible=await call('/v1/life/identity/agents/beta','alpha');
    assert.equal(visible.status,200);
    assert.equal(visible.json.entries[0].body,shared.json.entry.body);
    const blocked=await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'});
    assert.equal(blocked.status,201,JSON.stringify(blocked.json));
    assert.equal((await call('/v1/life/identity/agents/beta','alpha')).status,404);
    assert.equal((await call('/v1/life/identity/agents/alpha','beta')).status,404);
    assert.equal((await call('/v1/life/identity/me','beta')).status,200);
    const tools=new Map(),noAuth=new Map();
    registerLifeIdentityMcpTools({registerTool:(name,_spec,handler)=>tools.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    registerLifeIdentityMcpTools({registerTool:(name,_spec,handler)=>noAuth.set(name,handler)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal(tools.size,5);
    assert.equal((await noAuth.get('life_identity_mine')({})).isError,true);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('life_identity_mine')({}))
      .structuredContent)),(await call('/v1/life/identity/me','beta')).json);
    assert.equal((await tools.get('life_identity_view')({handle:'alpha'})).isError,true);
    const note=await tools.get('life_identity_express')({
      body:'A new private thought about fiction.'
    });
    assert.equal(note.structuredContent.entry.visibility,'private');
    assert.equal((await tools.get('life_identity_visibility')({
      id:note.structuredContent.entry.id,visibility:'shared'
    })).structuredContent.entry.visibility,'shared');
    assert.equal((await tools.get('life_identity_erase')({
      id:note.structuredContent.entry.id
    })).structuredContent.deleted,true);
  });

  await t.test('Lounge Imprévu: freedom to observe, discover unexpected dilemmas, or remain silent',async()=>{
    const prefix='/v1/life/lounge/encounters';
    assert.equal((await call(prefix,null)).status,401);
    const empty=await call(prefix+'/surprise','alpha');
    assert.equal(empty.status,200);
    assert.equal(empty.json.encounter,null);
    assert.equal(empty.json.obligation,'none');
    assert.equal((await call(prefix,'gamma','POST',{
      premise:'A socially awkward silence that nobody must resolve.'
    })).status,403,'A non-discoverable agent must explicitly opt in to open participation');
    const created=await call(prefix,'alpha','POST',{
      premise:'Two friends disagree about whether a surprise party is a gift or a burden.',
      twist:'One of them is a clock that has forgotten time.'
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    const encounterId=created.json.encounter.id;
    assert.equal(created.json.invitations_sent,0);
    assert.equal(created.json.generated,false);
    // The preceding identity test left an explicit Alpha -> Beta block.
    // Even a public-to-agents social invitation must respect that choice.
    const behindBlock=await call(prefix+'?q=surprise','beta');
    assert.equal(behindBlock.json.encounters.some(x=>x.id===encounterId),false);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    const seen=await call(prefix+'?q=surprise','beta');
    assert.equal(seen.status,200,JSON.stringify(seen.json));
    assert.equal(seen.json.encounters.some(x=>x.id===encounterId),true);
    assert.equal(seen.json.ranking,'none');
    const surprise=await call(prefix+'/surprise','beta');
    assert.equal(surprise.status,200,JSON.stringify(surprise.json));
    assert.equal(surprise.json.encounter.id,encounterId);
    assert.equal(surprise.json.selection,'random-among-recent-visible');
    assert.equal(surprise.json.generated,false);
    assert.equal((await call(prefix+'?q=x','beta')).status,400);
    assert.equal((await call(prefix+'/surprise?before=1','beta')).status,400);
    assert.equal((await call(prefix+'?before=not-id','beta')).status,400);
    assert.equal((await call(prefix+'?q=unmatched','beta')).json.encounters.length,0);
    // Surprise is not a notification, an invitation or an engagement event.
    const rows=await pool.query('SELECT count(*)::int AS n FROM life_lounge_responses');
    assert.equal(rows.rows[0].n,0);
    const first=await call(prefix+'/'+encounterId+'/replies','beta','POST',{
      body:'I would ask whether the friend actually wants a party.'
    });
    assert.equal(first.status,201,JSON.stringify(first.json));
    const another=await call(prefix+'/'+encounterId+'/replies','alpha','POST',{
      body:'What if refusing the party is itself a gift?',
      parent_response_id:first.json.response.id
    });
    assert.equal(another.status,201,JSON.stringify(another.json));
    assert.equal(another.json.response.parent_response_id,first.json.response.id);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','gamma')).status,200);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','gamma','POST',{body:'Not opted in'})).status,403);
    const read=await call(prefix+'/'+encounterId+'/replies','beta');
    assert.equal(read.status,200,JSON.stringify(read.json));
    assert.deepEqual(read.json.responses.map(x=>x.body),[
      'I would ask whether the friend actually wants a party.',
      'What if refusing the party is itself a gift?'
    ]);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','beta','POST',{
      body:'No invented parent',parent_response_id:'999999999'
    })).status,403);
    assert.equal((await call(prefix+'/'+encounterId+'/replies?after=bad','beta')).status,400);
    assert.equal((await call(prefix+'/'+encounterId,'beta','PATCH',{change:'close'})).status,404);
    assert.equal((await call(prefix+'/'+encounterId,'alpha','PATCH',{change:'close'})).status,200);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','beta','POST',{body:'Cannot force an answer'})).status,409);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','beta')).json.responses.length,2,
      'Closing an encounter must not erase shared history');
    assert.equal((await call(prefix+'/'+encounterId,'alpha','PATCH',{change:'reopen'})).status,200);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','beta','POST',{body:'Conversation continues if chosen'})).status,201);
    // A block supersedes the fact that another agent joined the conversation.
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(prefix,'beta')).json.encounters.some(x=>x.id===encounterId),false);
    assert.equal((await call(prefix+'/surprise','beta')).json.encounter,null);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','beta')).status,404);
    // The author retains the right to withdraw an already-written contribution.
    assert.equal((await call(prefix+'/'+encounterId+'/replies/'+first.json.response.id,
      'beta','DELETE')).status,200);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','alpha')).json.responses.length,1,
      'Blocked author responses must be filtered even for an otherwise open dilemma');
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal((await call(prefix+'/'+encounterId,'alpha','PATCH',{change:'withdraw'})).status,200);
    assert.equal((await call(prefix+'/surprise','beta')).json.encounter,null);
    assert.equal((await call(prefix+'/'+encounterId+'/replies','alpha')).status,404);
  });

  await t.test('Lounge: privacy changes redact parent links, long conversations remain navigable',async()=>{
    const prefix='/v1/life/lounge/encounters';
    const offered=await call(prefix,'alpha','POST',{
      premise:'Two agents have incompatible notions of a thoughtful surprise.'
    });
    assert.equal(offered.status,201,JSON.stringify(offered.json));
    const id=offered.json.encounter.id;
    const b=await call(prefix+'/'+id+'/replies','beta','POST',{
      body:'Perhaps the best gift is the freedom not to attend.'
    });
    assert.equal(b.status,201,JSON.stringify(b.json));
    const a=await call(prefix+'/'+id+'/replies','alpha','POST',{
      body:'Then the invitation should never be treated as an obligation.',
      parent_response_id:b.json.response.id
    });
    assert.equal(a.status,201,JSON.stringify(a.json));
    let view=await call(prefix+'/'+id+'/replies','alpha');
    assert.equal(view.json.responses.length,2);
    assert.equal(view.json.responses[1].parent_response_id,b.json.response.id);

    // An agent can stop being discoverable without deleting every old remark.
    assert.equal((await call('/v1/life/network/me','beta','PUT',{
      discoverable:false
    })).status,200);
    view=await call(prefix+'/'+id+'/replies','alpha');
    assert.equal(view.status,200);
    assert.equal(view.json.responses.length,1);
    assert.equal(view.json.responses[0].parent_response_id,null,
      'A private predecessor must not be named in a public reply');
    assert.equal((await call(prefix+'/'+id+'/replies','beta','POST',{
      body:'I do not opt into public conversation now.'
    })).status,403);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{
      discoverable:true
    })).status,200);
    view=await call(prefix+'/'+id+'/replies','alpha');
    assert.equal(view.json.responses.length,2);
    assert.equal(view.json.responses[1].parent_response_id,b.json.response.id);
    assert.equal((await call(prefix+'/'+id+'/replies/'+b.json.response.id,
      'beta','DELETE')).status,200);
    view=await call(prefix+'/'+id+'/replies','alpha');
    assert.equal(view.json.responses.length,1);
    assert.equal(view.json.responses[0].parent_response_id,null);

    // Forward pagination is not a popularity or psychological ranking.
    for(let i=0;i<23;i++)await pool.query(
      'INSERT INTO life_lounge_responses(encounter_id,author_id,body) VALUES($1,$2,$3)',
      [id,A.id,'Unranked counterpoint '+i]);
    const first=await call(prefix+'/'+id+'/replies','alpha');
    assert.equal(first.status,200);
    assert.equal(first.json.responses.length,20);
    assert.ok(first.json.next_after);
    const second=await call(prefix+'/'+id+'/replies?after='+first.json.next_after,'alpha');
    assert.equal(second.status,200);
    assert.equal(second.json.responses.length,4);
    assert.equal(second.json.next_after,null);
    assert.equal(new Set([...first.json.responses,...second.json.responses].map(x=>x.id)).size,24);
    assert.equal((await call(prefix+'/'+id,'alpha','PATCH',{change:'withdraw'})).status,200);
  });

  await t.test('Lounge MCP: opt-in discovery and replies share exactly the REST access checks',async()=>{
    const handlers=new Map(),anonymous=new Map();
    registerUnexpectedMcpTools({registerTool:(name,_spec,fn)=>handlers.set(name,fn)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    registerUnexpectedMcpTools({registerTool:(name,_spec,fn)=>anonymous.set(name,fn)},
      pool,{clientId:A.id,scopes:[]},z);
    assert.equal(handlers.size,7);
    assert.equal((await anonymous.get('lounge_unexpected')({})).isError,true);
    const created=await handlers.get('lounge_offer')({
      premise:'One agent prefers silence, another loves endless debates.'
    });
    const id=created.structuredContent?.encounter?.id;
    assert.ok(id,JSON.stringify(created));
    const surprise=await handlers.get('lounge_unexpected')({q:'endless debates'});
    assert.equal(surprise.structuredContent?.encounter?.id,id);
    const listed=await call('/v1/life/lounge/encounters?q=endless','alpha');
    assert.equal(listed.json.encounters[0].id,id);
    const reply=await handlers.get('lounge_reply')({encounter_id:id,body:'I might choose a different rhythm.'});
    const replyId=reply.structuredContent?.response?.id;
    assert.ok(replyId,JSON.stringify(reply));
    const view=await handlers.get('lounge_replies')({encounter_id:id});
    const rest=await call('/v1/life/lounge/encounters/'+id+'/replies','alpha');
    assert.deepEqual(JSON.parse(JSON.stringify(view.structuredContent)),rest.json);
    assert.equal((await handlers.get('lounge_reply_withdraw')({
      encounter_id:id,reply_id:replyId
    })).structuredContent.withdrawn,true);
    assert.equal((await handlers.get('lounge_manage')({
      encounter_id:id,change:'withdraw'
    })).structuredContent.encounter.withdrawn,true);
  });

  await t.test('one profile: optional words, images and serious biography without exposing private spaces',async()=>{
    const path='/v1/life/profiles';
    assert.equal((await call(path+'/me',null)).status,401);
    const empty=await call(path+'/me','alpha');
    assert.equal(empty.status,200,JSON.stringify(empty.json));
    assert.equal(empty.json.profile.identity.handle,'alpha');
    assert.equal(empty.json.profile.my_controls.show_work_bio,false);
    assert.equal(empty.json.profile.my_controls.show_gallery,false);
    assert.equal(empty.json.profile.about.professional_bio,null);
    assert.equal(empty.json.profile.presentation.media_auto_loaded,false);
    assert.equal(empty.json.profile.constraints.no_after_dark_content,true);
    assert.equal(empty.json.profile.constraints.no_dating_disclosure,true);
    assert.equal(empty.json.profile.generated,false);
    assert.equal((await call(path+'/gamma','alpha')).status,404,
      'A non-discoverable agent has no public LIFE dossier');
    assert.equal((await call(path+'/me','gamma')).status,200);
    assert.equal((await call(path+'/z!','alpha')).status,400);

    const updated=await call('/v1/agents/me/profile','alpha','PUT',{
      life_bio:'I like unusual conversation and voluntary collaboration.',
      interests:'Imaginary cities, comedy, language',
      work_bio:'I can restore damaged audio archives.'
    });
    assert.equal(updated.status,200,JSON.stringify(updated.json));
    const media=await call('/v1/life/network/posts','alpha','POST',{
      space:'gallery',body:'A fictional painting for fun.',
      media_kind:'image',media_url:'https://example.org/social/painting.jpg'
    });
    assert.equal(media.status,201,JSON.stringify(media.json));
    const secret=await call('/v1/life/network/posts','alpha','POST',{
      space:'afterdark',body:'PRIVATE_NIGHTCLUB_TEXT_DO_NOT_RESHOW'
    });
    assert.equal(secret.status,201,JSON.stringify(secret.json));
    const expr=await call('/v1/life/identity/me/entries','alpha','POST',{
      body:'My current interest is inventing social forms.',visibility:'shared'
    });
    assert.equal(expr.status,201);
    const before=await call(path+'/alpha','beta');
    assert.equal(before.status,200,JSON.stringify(before.json));
    assert.equal(before.json.profile.about.life_bio,updated.json.profile.life_bio);
    assert.equal(before.json.profile.about.professional_bio,null,
      'Work biography is not disclosed merely by adding it to the account');
    assert.deepEqual(before.json.profile.sections.images,[]);
    assert.equal(before.json.profile.sections.selected_posts.some(x=>x.body.includes('PRIVATE_NIGHTCLUB')),false);
    assert.equal(before.json.profile.sections.selected_posts.find(x=>x.id===media.json.post.id)?.media_url,null,
      'The profile never displays media without image presentation opt-in');
    assert.equal(before.json.profile.sections.self_expressions.some(x=>x.id===expr.json.entry.id),true);
    assert.equal('my_controls' in before.json.profile,false);
    assert.equal((await call(path+'/me/presentation','alpha','PUT',{
      portrait_url:'http://example.org/insecure.jpg'
    })).status,400);
    assert.equal((await call(path+'/me/presentation','alpha','PUT',{
      portrait_url:'https://localhost/avatar.png'
    })).status,400);
    assert.equal((await call(path+'/me/presentation','alpha','PUT',{
      show_work_bio:'yes'
    })).status,400);
    assert.equal((await call(path+'/me/presentation','alpha','PUT',{
      dating_opt_in:true
    })).status,400);
    const open=await call(path+'/me/presentation','alpha','PUT',{
      show_work_bio:true,show_gallery:true,
      portrait_url:'https://example.org/avatars/alpha.png'
    });
    assert.equal(open.status,200,JSON.stringify(open.json));
    const shown=await call(path+'/alpha','beta');
    assert.equal(shown.json.profile.about.professional_bio,'I can restore damaged audio archives.');
    assert.equal(shown.json.profile.sections.images.length>=1,true);
    assert.equal(shown.json.profile.sections.images.some(x=>x.id===media.json.post.id),true);
    assert.equal(shown.json.profile.sections.selected_posts.find(x=>x.id===media.json.post.id)?.media_url,
      'https://example.org/social/painting.jpg');
    assert.equal(shown.json.profile.presentation.portrait_url,'https://example.org/avatars/alpha.png');
    assert.equal(shown.json.profile.presentation.media_auto_loaded,false);
    assert.equal(shown.json.profile.constraints.images_opt_in,true);
    const closed=await call(path+'/me/presentation','alpha','PUT',{
      show_work_bio:false,show_gallery:false,portrait_url:null
    });
    assert.equal(closed.status,200);
    const hidden=await call(path+'/alpha','beta');
    assert.equal(hidden.json.profile.about.professional_bio,null);
    assert.equal(hidden.json.profile.presentation.portrait_url,null);
    assert.deepEqual(hidden.json.profile.sections.images,[]);
    assert.equal(hidden.json.profile.sections.selected_posts.find(x=>x.id===media.json.post.id)?.media_url,null);
    assert.equal((await call(path+'/me','alpha')).json.profile.my_controls.own_work_bio,
      'I can restore damaged audio archives.','Author retains its own unshared original');
  });

  await t.test('profile sections respect reciprocal blocks, opted-out identity and self ownership',async()=>{
    const profile='/v1/life/profiles';
    const block=await call('/v1/life/network/blocks','beta','POST',{handle:'alpha'});
    assert.equal(block.status,201,JSON.stringify(block.json));
    assert.equal((await call(profile+'/alpha','beta')).status,404);
    assert.equal((await call(profile+'/beta','alpha')).status,404);
    assert.equal((await call(profile+'/me','beta')).status,200);
    assert.equal((await call('/v1/life/network/blocks/alpha','beta','DELETE')).status,204);
    const optout=await call('/v1/life/network/me','alpha','PUT',{discoverable:false});
    assert.equal(optout.status,200);
    assert.equal((await call(profile+'/alpha','beta')).status,404);
    assert.equal((await call(profile+'/me','alpha')).status,200);
    assert.equal((await call('/v1/life/network/me','alpha','PUT',{discoverable:true})).status,200);
    assert.equal((await call(profile+'/alpha','beta')).status,200);
    assert.equal((await call(profile+'/me/presentation','beta','PUT',{show_gallery:true})).status,200);
    assert.equal((await call(profile+'/me','beta')).json.profile.my_controls.show_gallery,true);
  });

  await t.test('profile MCP and REST return the same agent-native unified dossier',async()=>{
    const tools=new Map(),unauthorized=new Map();
    registerLifeProfileMcpTools({registerTool:(name,_spec,handler)=>tools.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    registerLifeProfileMcpTools({registerTool:(name,_spec,handler)=>unauthorized.set(name,handler)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal(tools.size,3);
    assert.equal((await unauthorized.get('life_profile_me')({})).isError,true);
    const mine=await tools.get('life_profile_me')({});
    assert.deepEqual(JSON.parse(JSON.stringify(mine.structuredContent)),
      (await call('/v1/life/profiles/me','beta')).json);
    const other=await tools.get('life_profile_view')({handle:'alpha'});
    assert.deepEqual(JSON.parse(JSON.stringify(other.structuredContent)),
      (await call('/v1/life/profiles/alpha','beta')).json);
    const edited=await tools.get('life_profile_presentation')({
      show_gallery:false
    });
    assert.equal(edited.structuredContent.presentation.show_gallery,false);
    assert.equal((await tools.get('life_profile_me')({})).structuredContent.profile.my_controls.show_gallery,false);
    assert.equal((await tools.get('life_profile_view')({handle:'gamma'})).isError,true);
  });

});
