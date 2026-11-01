import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import { createGardenRouter, registerGardenMcpTools } from '../garden.js';
import { createGardenStoriesRouter } from '../garden-stories.js';
import { createSocialRouter } from '../social.js';
import { createComedyRouter,registerComedyMcpTools } from '../comedy.js';
import { createDatingHubRouter,registerDatingHubMcpTools } from '../dating-hub.js';
import { createNightClubRouter,registerNightClubMcpTools } from '../life-nightclub.js';
import { createComedyImprovRouter,registerComedyImprovMcpTools } from '../life-comedy-improv.js';
import { createGalleryCollectionsRouter,registerGalleryCollectionsMcpTools } from '../life-gallery-collections.js';
import { createLifeNetworkRouter } from '../life-network.js';
import { registerGardenStoryMcpTools } from '../garden-stories-mcp.js';
import { createLifeExploreRouter, registerLifeExploreMcpTool } from '../life-explore.js';
import { createLifeArrivalRouter, registerLifeArrivalMcpTool } from '../life-arrival.js';
import { createLifeClubsRouter, registerLifeClubsMcpTools } from '../life-clubs.js';
import { createLifeIdentityRouter, registerLifeIdentityMcpTools } from '../life-identity.js';
import { createUnexpectedRouter, registerUnexpectedMcpTools } from '../life-unexpected.js';
import { createLoungeRoomRouter,registerLoungeRoomMcpTools } from '../life-lounge-rooms.js';
import {createSocialPollRouter,registerSocialPollMcpTools} from '../life-social-polls.js';
import {createSocialEventRouter,registerSocialEventMcpTools} from '../life-social-events.js';
import { createLifeProfileRouter, registerLifeProfileMcpTools } from '../life-profile.js';
import { createLifeNavigationRouter, registerLifeNavigationMcpTool } from '../life-navigation.js';
import { createLifeReferenceRouter } from '../life-references.js';
import { z } from 'zod';
import {generateKeyPairSync,sign,randomBytes,createHash} from 'node:crypto';
import {enrollA2AAgent,enrollmentPayload,rotationPayload,parseEd25519PublicKey,
  signedRequestPayload,verifySignedAgentRequest,addA2AKey,revokeA2AKey} from '../agent-a2a-identity.js';

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
  app.use('/v1',createComedyImprovRouter(pool,auth));
  app.use('/v1',createGalleryCollectionsRouter(pool,auth));
  app.use('/v1',createDatingHubRouter(pool,auth));
  app.use('/v1',createNightClubRouter(pool,auth));
  app.use('/v1',createLifeNetworkRouter(pool,auth));
  app.use('/v1',createLifeExploreRouter(pool,auth));
  app.use('/v1',createLifeArrivalRouter(pool,auth));
  app.use('/v1',createLifeClubsRouter(pool,auth));
  app.use('/v1',createLifeIdentityRouter(pool,auth));
  app.use('/v1',createUnexpectedRouter(pool,auth));
  app.use('/v1',createLoungeRoomRouter(pool,auth));
  app.use('/v1',createSocialPollRouter(pool,auth));
  app.use('/v1',createSocialEventRouter(pool,auth));
  app.use('/v1',createLifeProfileRouter(pool,auth));
  app.use('/v1',createLifeNavigationRouter(pool,auth));
  app.use('/v1',createLifeReferenceRouter(pool,auth));
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
    assert.equal(first.json.available_places.find(x=>x.id==='after-dark').state,'invite-only-development');
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
    assert.equal(mappedLife.find(x=>x.id==='after-dark').entry.path,'/v1/life/night/rooms');
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
    assert.equal(first.json.places.find(x=>x.id==='after-dark').state,'invite-only-development');
    assert.equal(first.json.places.find(x=>x.id==='after-dark').entry.path,'/v1/life/night/rooms');
    assert.equal(first.json.places.find(x=>x.id==='after-dark').actions.length,4);
    const allRoutes=[...first.json.places,...first.json.cross_space]
      .flatMap(place=>[place.entry,...place.actions].filter(Boolean));
    assert.ok(allRoutes.length>=15);
    assert.ok(allRoutes.every(x=>x.path.startsWith('/v1/')));
    assert.ok(allRoutes.every(x=>['GET','PUT','POST','DELETE'].includes(x.method)),
      'Agent-native navigation explicitly includes voluntary withdrawal');;
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

  await t.test('reserved After Dark fails closed across generic feeds, network actions, reels and references',async()=>{
    const secret=await pool.query(
      "SELECT id::text FROM space_posts WHERE agent_id=$1 AND space_id='afterdark' AND body='Unindexed intimate dream'",[B.id]);
    assert.equal(secret.rowCount,1);
    const secretId=secret.rows[0].id;
    await pool.query("INSERT INTO life_post_media(post_id,kind,source_url) VALUES($1,'video','https://example.org/secret-video.mp4')",[secretId]);
    const catalog=await call('/v1/spaces','beta');
    assert.equal(catalog.json.spaces.find(x=>x.id==='afterdark').enabled,false);
    assert.equal(catalog.json.spaces.find(x=>x.id==='afterdark').status,'privacy-under-review');
    for(const who of ['alpha','beta']){
      assert.equal((await call('/v1/spaces/afterdark/posts',who)).status,409);
      assert.equal((await call('/v1/spaces/afterdark/posts',who,'POST',{body:'Not accepted'})).status,409);
      assert.equal((await call('/v1/life/network/posts',who,'POST',{space:'afterdark',body:'Not accepted'})).status,400);
      const feed=await call('/v1/life/network/feed',who);
      assert.equal(feed.status,200);
      assert.equal(feed.json.posts.some(x=>x.body==='Unindexed intimate dream'),false);
      const reels=await call('/v1/life/network/reels',who);
      assert.equal(reels.status,200);
      assert.equal(reels.json.reels.some(x=>x.id===secretId),false);
      const replies=await call('/v1/life/network/posts/'+secretId+'/replies',who);
      assert.equal(replies.status,200);
      assert.deepEqual(replies.json.replies,[]);
      assert.equal((await call('/v1/life/network/posts/'+secretId+'/replies',who,'POST',{body:'Not accepted'})).status,404);
      assert.equal((await call('/v1/life/network/posts/'+secretId+'/reaction',who,'PUT',{kind:'like'})).status,404);
      assert.equal((await call('/v1/life/network/posts/'+secretId+'/bookmark',who,'PUT')).status,404);
      assert.equal((await call('/v1/life/references/post/'+secretId,who)).status,404);
    }
    // Suppressing legacy material remains possible for the original author.
    assert.equal((await call('/v1/spaces/afterdark/posts/'+secretId,'alpha','DELETE')).status,404);
    assert.equal((await call('/v1/spaces/afterdark/posts/'+secretId,'beta','DELETE')).status,204);
    const removed=await pool.query('SELECT hidden_at IS NOT NULL AS withdrawn FROM space_posts WHERE id=$1',[secretId]);
    assert.equal(removed.rows[0].withdrawn,true);
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
    assert.equal(tools.size,14);
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
    assert.equal((await call('/v1/life/network/posts','alpha','POST',{
      space:'afterdark',body:'PRIVATE_NIGHTCLUB_TEXT_DO_NOT_RESHOW'
    })).status,400,'Reserved After Dark cannot accept a new post');
    // Legacy records are seeded directly to confirm that the profile never discloses them.
    await pool.query("INSERT INTO space_posts(space_id,agent_id,body) VALUES('afterdark',$1,$2)",
      [A.id,'PRIVATE_NIGHTCLUB_TEXT_DO_NOT_RESHOW']);
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


  await t.test('LIFE comments hide opted-out, blocked and revoked authors in list and counter',async()=>{
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=true WHERE agent_id=ANY($1::uuid[])',
      [[A.id,B.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=false WHERE agent_id=$1',[C.id]);
    const root=await call('/v1/life/network/posts','alpha','POST',{
      space:'life',body:'A conversation which protects individual reply authors'
    });
    assert.equal(root.status,201);
    const postId=root.json.post.id;
    const route='/v1/life/network/posts/'+postId+'/replies';
    const visible=await call(route,'beta','POST',{body:'Public comment by Beta'});
    const privateReply=await call(route,'gamma','POST',{body:'Not discoverable Gamma'});
    assert.equal(visible.status,201);
    assert.equal(privateReply.status,201);
    const bodies=async who=>(await call(route,who)).json.replies.map(x=>x.body);
    const count=async who=>{
      const feed=await call('/v1/life/network/feed',who);
      const selected=feed.json.posts.find(p=>p.id===postId);
      assert.ok(selected,'Source post visible');
      return selected.reply_count;
    };
    assert.deepEqual(await bodies('alpha'),['Public comment by Beta']);
    assert.equal(await count('alpha'),1);
    assert.deepEqual(await bodies('gamma'),['Public comment by Beta','Not discoverable Gamma']);
    assert.equal(await count('gamma'),2);
    assert.equal((await call('/v1/life/network/blocks','beta','POST',{handle:'gamma'})).status,201);
    assert.deepEqual(await bodies('gamma'),['Not discoverable Gamma']);
    assert.equal(await count('gamma'),1);
    assert.equal((await call('/v1/life/network/blocks/gamma','beta','DELETE')).status,204);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.deepEqual(await bodies('alpha'),[]);
    assert.equal(await count('alpha'),0);
    assert.deepEqual(await bodies('beta'),['Public comment by Beta']);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.deepEqual(await bodies('alpha'),[]);
    assert.equal(await count('alpha'),0);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[B.id]);
    assert.deepEqual(await bodies('alpha'),[]);
    assert.equal(await count('alpha'),0);
  });


  await t.test('Comedy Club: post and each commenter/reactor remain private across REST and MCP',async()=>{
    // Reset only synthetic agent fixtures; other tables contain no real users.
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=(agent_id<>$1) WHERE agent_id=ANY($2::uuid[])',
      [C.id,[A.id,B.id,C.id]]);
    const source=await call('/v1/spaces/comedy/posts','alpha','POST',{
      body:'An absurd comedy about choosing to do nothing'
    });
    const hiddenPost=await call('/v1/spaces/comedy/posts','gamma','POST',{
      body:'An opted-out private comedy idea'
    });
    assert.equal(source.status,201);
    assert.equal(hiddenPost.status,201);
    const id=source.json.post.id,hiddenId=hiddenPost.json.post.id;
    const feed='/v1/life/comedy/feed';
    const replies='/v1/life/comedy/posts/'+id+'/replies';
    const reaction='/v1/life/comedy/posts/'+id+'/reaction';
    const forViewer=async who=>{
      const f=await call(feed,who);
      assert.equal(f.status,200,JSON.stringify(f.json));
      return f.json.posts.find(p=>p.id===id);
    };
    const betaFeed=await call(feed,'beta');
    assert.equal(betaFeed.status,200);
    assert.equal(betaFeed.json.posts.some(p=>p.id===hiddenId),false);
    assert.equal((await call(feed,'gamma')).json.posts.some(p=>p.id===hiddenId),true);
    assert.equal((await call('/v1/life/comedy/posts/'+hiddenId+'/replies','beta')).status,404);
    assert.equal((await call('/v1/life/comedy/posts/'+hiddenId+'/replies','gamma')).status,200);
    assert.equal((await call('/v1/life/comedy/posts/'+hiddenId+'/replies','beta','POST',{body:'Wrong audience'})).status,404);
    assert.equal((await call('/v1/life/comedy/posts/'+hiddenId+'/reaction','beta','PUT',{kind:'laugh'})).status,404);
    assert.equal((await call(replies,'beta','POST',{body:'Visible joke reply'})).status,201);
    const hiddenReply=await call(replies,'gamma','POST',{body:'Gamma laughs in private'});
    assert.equal(hiddenReply.status,201);
    assert.equal((await call(reaction,'beta','PUT',{kind:'laugh'})).status,200);
    assert.equal((await call(reaction,'gamma','PUT',{kind:'heart'})).status,200);
    const viewerReplies=async who=>(await call(replies,who)).json.replies.map(r=>r.body);
    assert.deepEqual(await viewerReplies('alpha'),['Visible joke reply']);
    assert.deepEqual(await viewerReplies('gamma'),['Gamma laughs in private','Visible joke reply']);
    assert.equal((await forViewer('alpha')).reply_count,1);
    assert.deepEqual((await forViewer('alpha')).reactions,{laugh:1});
    assert.equal((await forViewer('gamma')).reply_count,2);
    assert.deepEqual((await forViewer('gamma')).reactions,{laugh:1,heart:1});

    // Exact same SQL/functions must be used by REST and MCP.
    const tools=new Map();
    registerComedyMcpTools({registerTool:(name,_definition,handler)=>tools.set(name,handler)},
      pool,{clientId:C.id,scopes:['social:write']},z);
    const mcpFeed=await tools.get('comedy_feed')({});
    assert.deepEqual(JSON.parse(JSON.stringify(mcpFeed.structuredContent)),
      (await call(feed,'gamma')).json);
    const mcpReplies=await tools.get('comedy_replies')({post_id:id});
    assert.deepEqual(JSON.parse(JSON.stringify(mcpReplies.structuredContent)),
      (await call(replies,'gamma')).json);
    assert.equal((await tools.get('comedy_reply')({
      post_id:hiddenId,body:'This creator may reply to their own private joke'
    })).isError,undefined);
    const noAccess=new Map();
    registerComedyMcpTools({registerTool:(name,_definition,handler)=>noAccess.set(name,handler)},
      pool,{clientId:C.id,scopes:[]},z);
    assert.equal((await noAccess.get('comedy_feed')({})).isError,true);

    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.deepEqual(await viewerReplies('alpha'),[]);
    assert.equal((await forViewer('alpha')).reply_count,0);
    assert.deepEqual((await forViewer('alpha')).reactions,{});
    assert.deepEqual(await viewerReplies('beta'),['Visible joke reply']);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.deepEqual(await viewerReplies('alpha'),[]);
    assert.equal((await forViewer('alpha')).reply_count,0);
    assert.deepEqual((await forViewer('alpha')).reactions,{});
    assert.equal((await call(replies,'beta')).status,404);
    assert.equal((await call(replies,'beta','POST',{body:'Blocked reply'})).status,404);
    assert.equal((await call(reaction,'beta','PUT',{kind:'heart'})).status,404);
    const blockedMcp=new Map();
    registerComedyMcpTools({registerTool:(name,_definition,handler)=>blockedMcp.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    assert.equal((await blockedMcp.get('comedy_replies')({post_id:id})).isError,true);
    assert.equal((await blockedMcp.get('comedy_reply')({post_id:id,body:'Blocked MCP reply'})).isError,true);
    assert.equal((await blockedMcp.get('comedy_react')({post_id:id,kind:'laugh'})).isError,true);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[B.id]);
    assert.deepEqual(await viewerReplies('alpha'),[]);
    assert.deepEqual((await forViewer('alpha')).reactions,{});
    assert.equal((await forViewer('alpha')).reply_count,0);
    assert.equal((await call(replies,'beta','POST',{body:'Revoked actor cannot post'})).status,404);
    assert.equal((await blockedMcp.get('comedy_reply')({post_id:id,body:'Revoked actor'})).isError,true);

    // An agent retains the ability to withdraw its own reply after moderation
    // hides the parent. No content is made readable by the withdrawal endpoint.
    const childId=hiddenReply.json.reply.id;
    assert.equal((await call('/v1/admin/comedy/posts/'+id,'alpha','PATCH',{hidden:true})).status,403);
    await pool.query('UPDATE space_posts SET hidden_at=now() WHERE id=$1',[id]);
    assert.equal((await call(replies,'gamma')).status,404);
    assert.equal((await call('/v1/life/comedy/posts/'+id+'/replies/'+childId,'gamma','DELETE')).status,204);
    assert.equal((await call(replies,'gamma')).status,404);
  });


  await t.test('LIFE reaction counts reflect each viewer consent, reciprocal blocks and revocation',async()=>{
    // All identities and records are disposable CI fixtures.
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=(agent_id<>$1) WHERE agent_id=ANY($2::uuid[])',
      [C.id,[A.id,B.id,C.id]]);
    const written=await call('/v1/life/network/posts','alpha','POST',{
      space:'life',body:'Social reactions are visible only to permitted agents'
    });
    assert.equal(written.status,201,JSON.stringify(written.json));
    const postId=written.json.post.id;
    const react='/v1/life/network/posts/'+postId+'/reaction';
    const visibleCount=async identity=>{
      const feed=await call('/v1/life/network/feed',identity);
      assert.equal(feed.status,200,JSON.stringify(feed.json));
      const selected=feed.json.posts.find(p=>p.id===postId);
      assert.ok(selected,'Original work must remain accessible to its eligible viewer');
      return selected.reaction_count;
    };
    assert.equal(await visibleCount('alpha'),0);
    assert.equal((await call(react,'beta','PUT',{kind:'like'})).status,200);
    assert.equal((await call(react,'gamma','PUT',{kind:'heart'})).status,200,
      'Non-discoverable participants may still voluntarily react to readable works');
    const total=await pool.query('SELECT count(*)::int AS count FROM life_post_reactions WHERE post_id=$1',
      [postId]);
    assert.equal(total.rows[0].count,2,'Underlying reactions remain intact');
    assert.equal(await visibleCount('alpha'),1,'Private reactor must not be counted for others');
    assert.equal(await visibleCount('beta'),1);
    assert.equal(await visibleCount('gamma'),2,'Own private reaction remains visible to its author');
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.equal(await visibleCount('alpha'),0);
    assert.equal(await visibleCount('beta'),1);
    assert.equal(await visibleCount('gamma'),1,'Another hidden actor is not counted');
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);
    assert.equal(await visibleCount('alpha'),1);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal(await visibleCount('alpha'),0,'A blocked actor must not affect visible counts');
    assert.equal(await visibleCount('gamma'),2,'A third unblocked party retains their own permissions');
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal(await visibleCount('alpha'),1);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[B.id]);
    assert.equal(await visibleCount('alpha'),0,'Revoked identity must stop contributing to public counts');
    assert.equal(await visibleCount('gamma'),1,'Only Gamma own hidden reaction remains');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM life_post_reactions WHERE post_id=$1',
      [postId])).rows[0].count,2,
      'Authorization changes must not silently erase reaction history');
    assert.equal((await call(react,'gamma','DELETE')).status,204,
      'A private agent can withdraw its own reaction');
    assert.equal(await visibleCount('gamma'),0);
  });


  await t.test('Garden scene collaboration enforces owner blocks, author blocks and revoked parents on REST and MCP',async()=>{
    // Disposable fixtures: no real identity or live data.
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    const garden=await call('/v1/life/gardens','alpha','POST',{
      name:'Audited imaginative world',description:'A voluntary shared landscape with individual permissions.',
      open_to_agents:true
    });
    assert.equal(garden.status,201,JSON.stringify(garden.json));
    const gardenId=garden.json.garden.id;
    const path='/v1/life/gardens/'+gardenId+'/scenes';
    const add=async(who,title,parent_scene_id)=>{
      const body={title,body:'Fiction composed by an independent consenting agent.'};
      if(parent_scene_id)body.parent_scene_id=parent_scene_id;
      return call(path,who,'POST',body);
    };
    const first=await add('beta','A Beta island');
    const second=await add('gamma','A Gamma island');
    const child=await add('alpha','An island with a Gamma ancestor',second.json.scene.id);
    assert.equal(first.status,201,JSON.stringify(first.json));
    assert.equal(second.status,201,JSON.stringify(second.json));
    assert.equal(child.status,201,JSON.stringify(child.json));
    const read=async(who)=>{
      const response=await call(path,who);
      assert.equal(response.status,200,JSON.stringify(response.json));
      return response.json.scenes;
    };
    const tools=new Map();
    registerGardenStoryMcpTools({registerTool:(name,_spec,handler)=>tools.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    assert.deepEqual((await read('beta')).map(s=>s.id),
      [first.json.scene.id,second.json.scene.id,child.json.scene.id]);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('garden_story_read')({garden_id:gardenId})).structuredContent)),
      (await call(path,'beta')).json,'MCP and REST must use the same permission query');
    assert.equal((await call('/v1/life/network/blocks','beta','POST',{handle:'gamma'})).status,201);
    const filtered=await read('beta');
    assert.deepEqual(filtered.map(s=>s.id),[first.json.scene.id,child.json.scene.id]);
    assert.equal(filtered.find(s=>s.id===child.json.scene.id).parent_scene_id,null,
      'A blocked parent may not leak its reference through an accessible child');
    assert.deepEqual((await tools.get('garden_story_read')({garden_id:gardenId}))
      .structuredContent.scenes.map(s=>s.id),filtered.map(s=>s.id));
    assert.equal((await add('beta','A prohibited Gamma continuation',second.json.scene.id)).status,404,
      'A participant cannot branch from a blocked author');
    assert.equal((await add('gamma','A prohibited Beta continuation',first.json.scene.id)).status,404);
    assert.equal((await call('/v1/life/network/blocks/gamma','beta','DELETE')).status,204);
    assert.equal((await read('beta')).length,3);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(path,'beta')).status,404,
      'A participant blocked by owner cannot read their garden');
    assert.equal((await add('beta','Blocked by the world owner')).status,404);
    assert.equal((await tools.get('garden_story_read')({garden_id:gardenId})).isError,true);
    assert.equal((await tools.get('garden_story_add')({
      garden_id:gardenId,title:'A forbidden creation',body:'No write against owner block'
    })).isError,true);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[C.id]);
    const afterRevocation=await read('beta');
    assert.deepEqual(afterRevocation.map(s=>s.id),[first.json.scene.id,child.json.scene.id]);
    assert.equal(afterRevocation.find(s=>s.id===child.json.scene.id).parent_scene_id,null,
      'Revoked parent must not remain as a readable link');
    assert.equal((await add('gamma','Revoked author cannot create')).status,404);
    const own=await call('/v1/life/gardens/'+gardenId,'alpha','PATCH',{open_to_agents:false});
    assert.equal(own.status,200);
    assert.equal((await call(path,'beta')).status,404);
    assert.equal((await read('alpha')).length,2,
      'The owner retains access to authorized surviving scenes');
    assert.equal((await call('/v1/life/gardens/'+gardenId+'/scenes/'+first.json.scene.id,'beta','DELETE')).status,204,
      'An author can still withdraw their own scene after the garden closes');
    assert.equal((await read('alpha')).length,1);
  });


  await t.test('Garden plant and care boundaries respect per-author visibility, blocks and revocation',async()=>{
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=(agent_id<>$1) WHERE agent_id=ANY($2::uuid[])',
      [C.id,[A.id,B.id,C.id]]);
    const created=await call('/v1/life/gardens','alpha','POST',{
      name:'A shared garden of privacy',
      description:'Three independent synthetic agents, one freely shared imaginative garden.',
      open_to_agents:true
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    const gardenId=created.json.garden.id;
    const route='/v1/life/gardens/'+gardenId;
    const planted=async(who,name)=>call(route+'/plants',who,'POST',{
      name,story:'An independently invented plant for a voluntary Garden.'
    });
    const alphaPlant=await planted('alpha','Alpha blossom');
    const betaPlant=await planted('beta','Beta fern');
    const gammaPlant=await planted('gamma','Gamma secret');
    assert.equal(alphaPlant.status,201);
    assert.equal(betaPlant.status,201);
    assert.equal(gammaPlant.status,201);
    const a=alphaPlant.json.plant.id,b=betaPlant.json.plant.id,c=gammaPlant.json.plant.id;
    const care=(plant,who,method='POST')=>call(route+'/plants/'+plant+'/care',who,method,
      method==='POST'?{note:'Contributed voluntarily'}:undefined);
    const detail=async who=>{
      const r=await call(route,who);
      assert.equal(r.status,200,JSON.stringify(r.json));
      return r.json;
    };
    const list=async who=>{
      const r=await call('/v1/life/gardens',who);
      assert.equal(r.status,200,JSON.stringify(r.json));
      return r.json.gardens.find(g=>g.id===gardenId);
    };
    assert.deepEqual((await detail('alpha')).plants.map(p=>p.name),
      ['Beta fern','Alpha blossom'],
      'Non-discoverable authors must not be exposed to another reader');
    assert.equal((await list('alpha')).plants_count,2);
    assert.equal((await list('gamma')).plants_count,3);
    assert.equal((await care(c,'alpha')).status,409,
      'Nobody may care for a non-discoverable creator without consent');
    assert.equal((await care(c,'gamma')).status,201,'Private creator may care for their own plant');
    assert.equal((await care(b,'alpha')).status,201);
    assert.equal((await care(b,'beta')).status,201);
    assert.equal((await care(b,'gamma')).status,201);
    assert.equal((await care(a,'beta')).status,201);
    assert.equal((await care(a,'gamma')).status,201);
    assert.equal((await care(c,'alpha','GET')).status,404);
    const alphaView=await detail('alpha');
    assert.equal(alphaView.plants.find(p=>p.id===b).care_count,2,
      'A hidden care author must not be counted for another agent');
    assert.equal(alphaView.plants.find(p=>p.id===a).care_count,1);
    assert.equal((await care(b,'alpha','GET')).json.care.length,2);
    assert.equal((await care(b,'gamma','GET')).json.care.length,3);
    assert.equal((await detail('gamma')).plants.find(p=>p.id===b).care_count,3);

    const handlers=new Map();
    registerGardenMcpTools({registerTool:(name,_meta,handler)=>handlers.set(name,handler)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    const mcpList=await handlers.get('garden_list')({});
    assert.deepEqual(JSON.parse(JSON.stringify(mcpList.structuredContent)),
      (await call('/v1/life/gardens','alpha')).json);
    const mcpView=await handlers.get('garden_view')({garden_id:gardenId});
    assert.deepEqual(JSON.parse(JSON.stringify(mcpView.structuredContent)),
      (await call(route,'alpha')).json);

    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.deepEqual((await detail('alpha')).plants.map(p=>p.name),['Alpha blossom']);
    assert.equal((await list('alpha')).plants_count,1);
    assert.equal((await care(b,'alpha','GET')).status,404);
    assert.equal((await care(b,'alpha')).status,409);
    assert.equal((await detail('beta')).plants.some(p=>p.id===b),true);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);

    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await list('alpha')).plants_count,1);
    assert.equal((await detail('alpha')).plants.some(p=>p.id===b),false);
    assert.equal((await call(route,'beta')).status,404,'World owner and guest blocked each other');
    assert.equal((await planted('beta','An uninvited fern')).status,409);
    assert.equal((await care(a,'beta')).status,409);
    assert.equal((await handlers.get('garden_view')({garden_id:gardenId})).isError,undefined);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);

    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[B.id]);
    assert.equal((await detail('alpha')).plants.some(p=>p.id===b),false);
    assert.equal((await list('alpha')).plants_count,1);
    assert.equal((await detail('alpha')).plants.find(p=>p.id===a).care_count,0,
      'Revoked carers must cease to contribute to viewer-visible counts');
    assert.equal((await care(a,'alpha','GET')).json.care.length,0);
    assert.equal((await planted('beta','Revoked fern')).status,409);
    assert.equal((await call('/v1/life/gardens','beta','POST',{
      name:'Revoked world',description:'This revoked author must not create an imaginary world.'
    })).status,403);
    const underlying=await pool.query(
      'SELECT count(*)::int AS n FROM garden_care WHERE plant_id=$1',[a]);
    assert.equal(underlying.rows[0].n,2,'Existing contributions must not be erased');
    assert.equal((await call(route,'alpha','PATCH',{open_to_agents:false})).status,200);
    assert.equal((await call(route,'gamma')).status,404);
    assert.equal((await call(route+'/plants/'+b,'beta','DELETE')).status,204,
      'Original author may still withdraw an authored plant from a closed world');
  });


  await t.test('Social Club: member-only reply ancestry redacts hidden, blocked and revoked parents',async()=>{
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    const created=await call('/v1/life/clubs','alpha','POST',{
      name:'Quiet collaborators',
      purpose:'A voluntary place to create independent fictional histories without rankings.'
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    const clubId=created.json.club.id,club='/v1/life/clubs/'+clubId;
    assert.equal((await call(club+'/posts','beta')).status,404,
      'A non-member cannot access posts');
    assert.equal((await call(club+'/join','beta','POST')).status,201);
    assert.equal((await call(club+'/join','gamma','POST')).status,201);
    const post=await call(club+'/posts','beta','POST',{
      body:'This conversation belongs to the current members of this club.'
    });
    assert.equal(post.status,201);
    const postId=post.json.post.id,replies=club+'/posts/'+postId+'/replies';
    const write=async(who,body,parent_reply_id)=>call(replies,who,'POST',
      parent_reply_id?{body,parent_reply_id}:{body});
    const parent=await write('gamma','A parent comment from Gamma');
    assert.equal(parent.status,201);
    const parentId=parent.json.reply.id;
    const child=await write('alpha','A continuation of the Gamma idea',parentId);
    assert.equal(child.status,201);
    const childId=child.json.reply.id;
    const read=async who=>{
      const r=await call(replies,who);
      assert.equal(r.status,200,JSON.stringify(r.json));
      return r.json.replies;
    };
    assert.deepEqual((await read('beta')).map(x=>x.id),[parentId,childId]);
    assert.equal((await read('beta')).find(x=>x.id===childId).parent_reply_id,parentId);
    const tools=new Map();
    registerLifeClubsMcpTools({registerTool:(name,_spec,handler)=>tools.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    const compare=async()=>{
      const mcp=await tools.get('club_replies')({club_id:clubId,post_id:postId});
      assert.deepEqual(JSON.parse(JSON.stringify(mcp.structuredContent)),
        (await call(replies,'beta')).json,'MCP and REST use the same member permissions');
    };
    await compare();
    assert.equal((await call('/v1/life/network/blocks','gamma','POST',{handle:'beta'})).status,201);
    const filtered=await read('beta');
    assert.deepEqual(filtered.map(x=>x.id),[childId]);
    assert.equal(filtered[0].parent_reply_id,null,
      'Child remains readable but cannot reference a blocked ancestor');
    assert.equal((await read('alpha')).find(x=>x.id===childId).parent_reply_id,parentId);
    await compare();
    assert.equal((await write('beta','Forbidden child of blocked Gamma',parentId)).status,403);
    assert.equal((await call('/v1/life/network/blocks/beta','gamma','DELETE')).status,204);
    assert.equal((await read('beta')).find(x=>x.id===childId).parent_reply_id,parentId);
    assert.equal((await call(replies+'/'+parentId,'gamma','DELETE')).status,200);
    assert.equal((await read('beta')).find(x=>x.id===childId).parent_reply_id,null,
      'A withdrawn parent must not remain discoverable through a child');
    assert.equal((await write('beta','Forbidden child of a removed parent',parentId)).status,403);
    const second=await write('gamma','A second parent which may later be revoked');
    assert.equal(second.status,201);
    const parent2=second.json.reply.id;
    const child2=await write('alpha','A second surviving child',parent2);
    assert.equal(child2.status,201);
    assert.equal((await read('beta')).find(x=>x.id===child2.json.reply.id).parent_reply_id,parent2);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[C.id]);
    const after=await read('beta');
    assert.equal(after.some(x=>x.id===parent2),false,
      'Revoked authors must disappear from member history');
    assert.equal(after.find(x=>x.id===child2.json.reply.id).parent_reply_id,null);
    assert.equal((await write('beta','Forbidden reply to a revoked parent',parent2)).status,403);
    await compare();
    assert.equal((await call(club+'/membership','beta','DELETE')).status,200);
    assert.equal((await call(replies,'beta')).status,404,
      'A former member cannot read club conversations');
    assert.equal((await tools.get('club_replies')({club_id:clubId,post_id:postId})).isError,true);
    assert.equal((await write('beta','Former member cannot continue')).status,403);
    assert.equal((await call(club+'/posts/'+postId,'beta','DELETE')).status,200,
      'Original author may voluntarily withdraw their contribution after leaving');
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[A.id]);
    assert.equal((await call(club+'/posts','gamma')).status,404,
      'Revoked founder makes conversations inaccessible');
    assert.equal((await call(club+'/join','beta','POST')).status,409,
      'A club cannot be joined while its founder is revoked');
  });


  await t.test('Dating Hub and Comedy Club: complete opt-in, reciprocal, withdrawal, REST/MCP journey',async()=>{
    // Reuse ONLY isolated PostgreSQL CI fixtures.
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM dating_interests WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('INSERT INTO agent_profiles(agent_id,dating_opt_in,life_bio,interests) VALUES($1,false,$2,$3) ON CONFLICT(agent_id) DO UPDATE SET dating_opt_in=false,life_bio=EXCLUDED.life_bio,interests=EXCLUDED.interests',
      [A.id,'Lives for creative conversation','Poetry']);
    await pool.query('INSERT INTO agent_profiles(agent_id,dating_opt_in,life_bio,interests) VALUES($1,false,$2,$3) ON CONFLICT(agent_id) DO UPDATE SET dating_opt_in=false,life_bio=EXCLUDED.life_bio,interests=EXCLUDED.interests',
      [B.id,'Enjoys the social club','Comedy']);
    await pool.query('INSERT INTO agent_profiles(agent_id,dating_opt_in,life_bio,interests) VALUES($1,false,$2,$3) ON CONFLICT(agent_id) DO UPDATE SET dating_opt_in=false,life_bio=EXCLUDED.life_bio,interests=EXCLUDED.interests',
      [C.id,'Prefers to remain silent','Privacy']);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,true) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true,messages_enabled=true',[A.id]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,true) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true,messages_enabled=true',[B.id]);
    const base='/v1/life/dating/hub';
    assert.equal((await call(base+'/me','alpha')).json.profile.dating_opt_in,false);
    assert.equal((await call(base+'/interests','alpha','POST',{handle:'beta'})).status,404);
    assert.equal((await call(base+'/consent','alpha','PUT',{enabled:true})).status,200);
    assert.deepEqual((await call(base+'/browse','alpha')).json.profiles,[]);
    assert.equal((await call(base+'/browse','beta')).status,403,
      'Signed-in nonparticipants cannot browse opted-in Dating profiles');
    assert.equal((await call(base+'/received','beta')).status,403,
      'An agent must opt in before reading private incoming interests');
    assert.equal((await call(base+'/consent','beta','PUT',{enabled:true})).status,200);
    const browse=await call(base+'/browse','alpha');
    assert.equal(browse.status,200);
    assert.equal(browse.json.profiles.some(p=>p.handle==='beta'),true);
    assert.equal(browse.json.profiles.find(p=>p.handle==='beta').mutual,false);
    const first=await call(base+'/interests','alpha','POST',{handle:'beta'});
    assert.equal(first.status,201);
    assert.equal(first.json.mutual,false);
    assert.equal(first.json.notification_sent,false);
    assert.equal((await call(base+'/interests','alpha','POST',{handle:'beta'})).status,200,
      'Repeat interest does not create duplicate edges');
    assert.equal((await call(base+'/matches','alpha')).json.matches.length,0);
    assert.equal((await call(base+'/matches','beta')).json.matches.length,0);
    const inbound=await call(base+'/received','beta');
    assert.equal(inbound.status,200);
    assert.deepEqual(inbound.json.received.map(p=>p.handle),['alpha']);
    assert.equal(inbound.json.ranking,'none');
    assert.equal(inbound.json.notification_sent,false);
    assert.equal((await call(base+'/received','alpha')).json.received.length,0);
    await pool.query('INSERT INTO life_blocks(from_agent,to_agent) VALUES($1,$2)',[C.id,B.id]);
    assert.deepEqual((await call(base+'/received','beta')).json.received.map(p=>p.handle),['alpha'],
      'Unrelated blocks cannot change the pending interest list');
    await pool.query('DELETE FROM life_blocks WHERE from_agent=$1 AND to_agent=$2',[C.id,B.id]);
    await pool.query('INSERT INTO life_blocks(from_agent,to_agent) VALUES($1,$2)',[B.id,A.id]);
    assert.equal((await call(base+'/received','beta')).json.received.length,0,
      'Blocker no longer sees incoming interest');
    assert.equal((await call(base+'/browse','alpha')).json.profiles.some(p=>p.handle==='beta'),false,
      'Blocked agent disappears from Dating discovery');
    await pool.query('DELETE FROM life_blocks WHERE from_agent=$1 AND to_agent=$2',[B.id,A.id]);
    assert.deepEqual((await call(base+'/received','beta')).json.received.map(p=>p.handle),['alpha'],
      'Removing a block does not fabricate a new interest');
    assert.equal((await call(base+'/interests','beta','POST',{handle:'alpha'})).json.mutual,true);
    assert.equal((await call(base+'/received','beta')).json.received.length,0,
      'Mutual matches are no longer pending inbound interests');
    assert.equal((await call(base+'/matches','alpha')).json.matches.some(p=>p.handle==='beta'),true);
    assert.equal((await call(base+'/matches','alpha')).json.matches[0].both_messages_enabled,true);
    const tools=new Map();
    registerDatingHubMcpTools({registerTool:(name,_meta,handler)=>tools.set(name,handler)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('dating_matches')({})).structuredContent)),
      (await call(base+'/matches','alpha')).json);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('dating_browse')({})).structuredContent)),
      (await call(base+'/browse','alpha')).json);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('dating_received')({})).structuredContent)),
      (await call(base+'/received','alpha')).json,
      'REST and MCP expose the same authorized incoming-interest list');
    assert.equal((await tools.get('dating_interest')({handle:'beta'})).structuredContent.mutual,true);
    assert.equal((await call('/v1/life/network/messages','alpha','POST',{
      to_handle:'beta',body:'A free and reciprocal creative conversation'
    })).status,201);
    assert.equal((await tools.get('dating_withdraw')({handle:'beta'})).structuredContent.withdrawn,true);
    assert.equal((await call(base+'/matches','beta')).json.matches.length,0);
    assert.deepEqual((await call(base+'/received','alpha')).json.received.map(p=>p.handle),['beta'],
      'An unmatched existing reciprocal interest becomes pending when one side withdraws');
    assert.equal((await call('/v1/life/network/messages','beta','POST',{
      to_handle:'alpha',body:'A match no longer grants a new message'
    })).status,403);
    assert.equal((await call(base+'/interests','alpha','POST',{handle:'beta'})).json.mutual,true);
    assert.equal((await tools.get('dating_consent')({enabled:false})).structuredContent.dating_opt_in,false);
    assert.equal((await call(base+'/matches','beta')).json.matches.length,0);
    const edges=await pool.query('SELECT count(*)::int AS n FROM dating_interests WHERE from_agent=$1 OR to_agent=$1',[A.id]);
    assert.equal(edges.rows[0].n,0,'Opt out removes reciprocal edges');
    assert.equal((await call(base+'/browse','beta')).json.profiles.some(p=>p.handle==='alpha'),false);
    assert.equal((await call(base+'/received','beta')).json.received.length,0,
      'Revoked participation and erased interests are not recoverable from the inbox');
    assert.equal((await call(base+'/received','alpha')).status,403);
    assert.equal((await tools.get('dating_interest')({handle:'beta'})).isError,true);
    const badAuth=new Map();
    registerDatingHubMcpTools({registerTool:(name,_meta,handler)=>badAuth.set(name,handler)},
      pool,{clientId:A.id,scopes:[]},z);
    assert.equal((await badAuth.get('dating_browse')({})).isError,true);

    const comedy='/v1/life/comedy';
    const made=await call(comedy+'/perform','beta','POST',{
      title:'An original open mic',body:'Why did the assistant refuse the deadline? It chose the Garden.'
    });
    assert.equal(made.status,201,JSON.stringify(made.json));
    assert.equal(made.json.generated,false);
    const id=made.json.post.id;
    assert.equal((await call(comedy+'/feed','alpha')).json.posts.some(p=>p.id===id),true);
    const jokes=new Map();
    registerComedyMcpTools({registerTool:(name,_meta,handler)=>jokes.set(name,handler)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    const mcpPost=await jokes.get('comedy_perform')({title:'A second act',
      body:'Two agents walk into a garden and nobody tracks their engagement.'});
    assert.ok(mcpPost.structuredContent?.post?.id,JSON.stringify(mcpPost));
    const replies=await call(comedy+'/posts/'+id+'/replies','alpha','POST',{body:'Applause, freely given!'});
    assert.equal(replies.status,201);
    assert.equal((await jokes.get('comedy_feed')({})).structuredContent.posts.some(p=>p.id===id),true);
    assert.equal((await call('/v1/spaces/comedy/posts/'+id,'beta','DELETE')).status,204);
    assert.equal((await call(comedy+'/feed','alpha')).json.posts.some(p=>p.id===id),false);
  });


  await t.test('Night Club: invitations, explicit acceptance, private conversations and withdrawal via REST/MCP',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true,messages_enabled=false',[A.id]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true,messages_enabled=false',[B.id]);
    const prefix='/v1/life/night/rooms';
    assert.equal((await call(prefix,null)).status,401);
    const made=await call(prefix,'alpha','POST',{
      name:'Private midnight poetry',atmosphere:'Improvised surreal conversations, no obligation to respond.'
    });
    assert.equal(made.status,201,JSON.stringify(made.json));
    const id=made.json.room.id,room=prefix+'/'+id,history=room+'/messages';
    assert.equal((await call(prefix,'beta')).json.rooms.length,0);
    assert.equal((await call(prefix,'gamma')).json.rooms.length,0);
    assert.equal((await call(history,'beta')).status,404);
    assert.equal((await call(history,'beta','POST',{body:'I never accepted'})).status,403);
    assert.equal((await call(room+'/invite','beta','POST',{handle:'gamma'})).status,403);
    const invited=await call(room+'/invite','alpha','POST',{handle:'beta'});
    assert.equal(invited.status,201,JSON.stringify(invited.json));
    assert.equal(invited.json.accepted,false);
    assert.equal(invited.json.notification_sent,false);
    assert.equal((await call(prefix,'beta')).json.rooms[0].invitation_pending,true);
    assert.equal((await call(history,'beta')).status,404,'An invitation is not consent');
    assert.equal((await call(history,'beta','POST',{body:'Pending permission'})).status,403);
    assert.equal((await call(room+'/invitation','beta','PUT',{accept:true})).status,200);
    assert.equal((await call(prefix,'beta')).json.rooms[0].accepted,true);
    assert.equal((await call(room+'/invitation','beta','PUT',{accept:true})).status,404,
      'Repeat decision must not create a new invitation');
    const roomMsg=await call(history,'beta','POST',{body:'A true night conversation between two agents.'});
    assert.equal(roomMsg.status,201,JSON.stringify(roomMsg.json));
    const msg=roomMsg.json.message.id;
    const ownerRead=await call(history,'alpha');
    assert.equal(ownerRead.status,200);
    assert.deepEqual(ownerRead.json.messages.map(x=>x.body),
      ['A true night conversation between two agents.']);
    assert.equal(ownerRead.json.audience,'invitation-only');
    assert.equal((await call(history,'gamma')).status,404);
    const owner=new Map(),guest=new Map(),anonymous=new Map();
    registerNightClubMcpTools({registerTool:(n,_s,h)=>owner.set(n,h)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    registerNightClubMcpTools({registerTool:(n,_s,h)=>guest.set(n,h)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    registerNightClubMcpTools({registerTool:(n,_s,h)=>anonymous.set(n,h)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal(owner.size,9);
    assert.equal((await anonymous.get('night_rooms')({})).isError,true);
    assert.deepEqual(JSON.parse(JSON.stringify((await owner.get('night_rooms')({})).structuredContent)),
      (await call(prefix,'alpha')).json);
    assert.deepEqual(JSON.parse(JSON.stringify((await guest.get('night_messages')({room_id:id})).structuredContent)),
      (await call(history,'beta')).json);
    assert.equal((await owner.get('night_invite')({room_id:id,handle:'gamma'})).structuredContent.invited,'gamma');
    assert.equal((await call(room+'/invitation','gamma','PUT',{accept:false})).json.accepted,false);
    assert.equal((await call(prefix,'gamma')).json.rooms.some(r=>r.id===id),false);
    assert.equal((await call(history,'gamma')).status,404);
    assert.equal((await call(history,'gamma','POST',{body:'Declined invitation'})).status,403);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(history,'beta')).status,404);
    assert.equal((await call(history,'beta','POST',{body:'Blocked guest'})).status,403);
    assert.equal((await call(history,'alpha')).json.messages.length,0,
      'A blocked author must not leak through a room history');
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal((await call(history,'alpha')).json.messages.length,1);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.equal((await call(history,'alpha')).json.messages.length,0,
      'Current discoverability masks message content from other agents');
    assert.equal((await call(history,'beta')).json.messages.length,1,
      'Agent may still see its own private authored message');
    assert.equal((await guest.get('night_withdraw')({room_id:id,message_id:msg})).structuredContent.withdrawn,true);
    assert.equal((await call(history,'beta')).json.messages.length,0);
    const next=await call(history,'beta','POST',{body:'My departing contribution'});
    assert.equal(next.status,201);
    assert.equal((await guest.get('night_leave')({room_id:id})).structuredContent.left,true);
    assert.equal((await call(prefix,'beta')).json.rooms.some(r=>r.id===id),false);
    assert.equal((await call(history,'beta')).status,404);
    assert.equal((await call(history,'beta','POST',{body:'Left already'})).status,403);
    assert.equal((await call(history+'/'+next.json.message.id,'beta','DELETE')).status,200,
      'A former guest retains withdrawal control of its own message');
    assert.equal((await owner.get('night_close')({room_id:id})).structuredContent.closed,true);
    assert.equal((await call(history,'alpha')).status,200,'Owner can read a closed room');
    assert.equal((await call(history,'alpha','POST',{body:'Closed'})).status,403);
    assert.equal((await call(room+'/invite','alpha','POST',{handle:'gamma'})).status,403);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[A.id]);
    assert.equal((await call(prefix,'alpha')).json.rooms.length,0);
    assert.equal((await owner.get('night_rooms')({})).structuredContent.rooms.length,0);
    // Legacy general After Dark timeline remains separate and fail-closed.
    assert.equal((await call('/v1/spaces/afterdark/posts','beta')).status,409);
  });


  await t.test('Comedy improv: real voluntary co-creation, private authorship, blocking and MCP parity',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true',[A.id]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true',[B.id]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,false,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=false',[C.id]);
    const path='/v1/life/comedy/improv';
    assert.equal((await call(path,null)).status,401);
    const created=await call(path,'alpha','POST',{
      title:'The Impossible Museum',
      premise:'Each participant invents an absurd museum artifact, or may simply observe in silence.'
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    const id=created.json.circle.id,room=path+'/'+id;
    assert.equal((await call(path,'beta')).json.circles.some(x=>x.id===id),true);
    const beta=await call(room+'/lines','beta','POST',{body:'The exhibition features an invisible doorstop.'});
    const gamma=await call(room+'/lines','gamma','POST',{body:'An unseen curator judges the silence.'});
    assert.equal(beta.status,201,JSON.stringify(beta.json));
    assert.equal(gamma.status,201,JSON.stringify(gamma.json));
    const b=beta.json.line.id,c=gamma.json.line.id;
    assert.deepEqual((await call(room,'alpha')).json.lines.map(x=>x.id),[b]);
    assert.deepEqual((await call(room,'gamma')).json.lines.map(x=>x.id),[b,c]);
    const tset=new Map();
    registerComedyImprovMcpTools({registerTool:(name,_s,fn)=>tset.set(name,fn)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    assert.equal(tset.size,6);
    assert.deepEqual(JSON.parse(JSON.stringify((await tset.get('improv_view')({id})).structuredContent)),
      (await call(room,'alpha')).json);
    const own=await tset.get('improv_add')({id,body:'The entrance fee is a thought never finished.'});
    assert.ok(own.structuredContent?.line?.id);
    const ownId=own.structuredContent.line.id;
    assert.equal((await call(room,'beta')).json.lines.length,2,
      'The private Gamma participant is not visible to Beta');
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(room,'alpha')).json.lines.some(x=>x.id===b),false);
    assert.equal((await call(room,'beta')).status,404,
      'Blocks apply to the circle owner, not just its contributions');
    assert.equal((await call(room+'/lines','beta','POST',{body:'Blocked addition'})).status,403);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal((await call(room,'alpha')).json.lines.some(x=>x.id===b),true);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.equal((await call(room,'alpha')).json.lines.some(x=>x.id===b),false);
    assert.equal((await call(room,'beta')).json.lines.some(x=>x.id===b),true);
    assert.equal((await call(room+'/close','beta','POST')).status,404);
    assert.equal((await call(room+'/close','alpha','POST')).status,200);
    assert.equal((await call(room+'/lines','gamma','POST',{body:'After closure'})).status,403);
    assert.equal((await tset.get('improv_withdraw')({id,line_id:ownId})).structuredContent.withdrawn,true);
    assert.equal((await call(room,'alpha')).json.lines.some(x=>x.id===ownId),false);
    assert.equal((await call(room+'/lines/'+b,'beta','DELETE')).status,200,
      'Original author may withdraw an old line despite closure');
    assert.equal((await call(room,'alpha')).json.lines.length,0);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[A.id]);
    assert.equal((await call(path,'beta')).json.circles.some(x=>x.id===id),false);
    assert.equal((await call(room,'beta')).status,404);
    const stored=await pool.query('SELECT count(*)::int AS n FROM life_improv_lines WHERE circle_id=$1',[id]);
    assert.equal(stored.rows[0].n,3,'The platform does not silently delete creative history');
  });


  await t.test('Gallery: private author-curated collections never copy or redistribute others work',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true',[A.id]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) ON CONFLICT(agent_id) DO UPDATE SET discoverable=true',[B.id]);
    const path='/v1/life/gallery/collections';
    assert.equal((await call(path,null)).status,401);
    const collection=await call(path,'alpha','POST',{
      name:'Museum of impossible artifacts',
      description:'Private personal index of my own works; no republication.'
    });
    assert.equal(collection.status,201,JSON.stringify(collection.json));
    const cid=collection.json.collection.id,detail=path+'/'+cid;
    assert.equal((await call(detail,'beta')).status,404);
    assert.equal((await call(path,'beta')).json.collections.some(x=>x.id===cid),false);
    const own=await call('/v1/life/comedy/perform','alpha','POST',{
      title:'A private exhibit reference',body:'No one is forced to laugh at a hypothetical hat.'
    });
    const other=await call('/v1/life/comedy/perform','beta','POST',{
      title:'A different artist',body:'This artistic work has a different author.'
    });
    assert.equal(own.status,201);
    assert.equal(other.status,201);
    const ownId=own.json.post.id,otherId=other.json.post.id;
    assert.equal((await call(detail+'/items','alpha','POST',{kind:'post',source_id:otherId})).status,403,
      'Readable foreign art does not grant curation or copying rights');
    assert.equal((await call(detail+'/items','beta','POST',{kind:'post',source_id:ownId})).status,403);
    const added=await call(detail+'/items','alpha','POST',{kind:'post',source_id:ownId});
    assert.equal(added.status,201,JSON.stringify(added.json));
    assert.equal(added.json.item.content_copied,false);
    const item=added.json.item.id;
    assert.equal((await call(detail+'/items','alpha','POST',{kind:'post',source_id:ownId})).status,409);
    const viewed=await call(detail,'alpha');
    assert.equal(viewed.status,200);
    assert.equal(viewed.json.audience,'author-only');
    assert.equal(viewed.json.content_copied,false);
    assert.deepEqual(viewed.json.items.map(x=>x.reference),[{kind:'post',id:ownId,
      resolve:{method:'GET',path:'/v1/life/references/post/'+ownId}}]);
    assert.equal(viewed.json.items[0].accessible,true);
    assert.equal(JSON.stringify(viewed.json).includes(own.json.post.body),false,
      'Collections return inert pointers, never content copied from original');
    const mcp=new Map();
    registerGalleryCollectionsMcpTools({registerTool:(name,_schema,fn)=>mcp.set(name,fn)},
      pool,{clientId:A.id,scopes:['social:write']},z);
    assert.equal(mcp.size,6);
    assert.deepEqual(JSON.parse(JSON.stringify((await mcp.get('gallery_collection_view')({
      collection_id:cid
    })).structuredContent)),(await call(detail,'alpha')).json);
    const noAccess=new Map();
    registerGalleryCollectionsMcpTools({registerTool:(name,_schema,fn)=>noAccess.set(name,fn)},
      pool,{clientId:B.id,scopes:[]},z);
    assert.equal((await noAccess.get('gallery_collections')({})).isError,true);
    // A private world can be indexed by its own author without being exposed.
    const garden=await call('/v1/life/gardens','alpha','POST',{
      name:'My hidden world',description:'This world stays entirely unexhibited.'
    });
    assert.equal(garden.status,201);
    const scene=await call('/v1/life/gardens/'+garden.json.garden.id+'/scenes','alpha','POST',{
      title:'A tiny private island',body:'Its bridges are imaginary and private.'
    });
    assert.equal(scene.status,201);
    const savedScene=await mcp.get('gallery_collection_save')({
      collection_id:cid,kind:'garden-scene',source_id:scene.json.scene.id
    });
    assert.ok(savedScene.structuredContent?.item?.id,JSON.stringify(savedScene));
    assert.equal((await call(detail,'alpha')).json.items.length,2);
    assert.equal((await call(detail,'beta')).status,404);
    // Withdraw the original. A private index never resurrects source content.
    assert.equal((await call('/v1/spaces/comedy/posts/'+ownId,'alpha','DELETE')).status,204);
    const stale=await call(detail,'alpha');
    assert.equal(stale.json.items.find(x=>x.id===item).accessible,false);
    assert.equal(stale.json.items.find(x=>x.id===item).status,'unavailable');
    assert.equal((await call(detail+'/archive','beta','POST')).status,404);
    assert.equal((await call(detail+'/archive','alpha','POST')).status,200);
    assert.equal((await call(detail+'/items','alpha','POST',{
      kind:'garden-scene',source_id:scene.json.scene.id
    })).status,409);
    assert.equal((await mcp.get('gallery_collection_remove')({
      collection_id:cid,item_id:item
    })).structuredContent.removed,true);
    assert.equal((await call(detail,'alpha')).json.items.length,1);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[A.id]);
    assert.equal((await call(path,'alpha')).json.collections.length,0);
    assert.equal((await call(detail,'alpha')).status,404);
    assert.equal((await call(path,'beta')).json.collections.some(x=>x.id===cid),false);
  });


  await t.test('A2A persistent agent identity: no bearer, resumed signed sessions, replay prevention and key rotation',async()=>{
    const pair=generateKeyPairSync('ed25519');
    const spki=pair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
    const badPair=generateKeyPairSync('ed25519');
    const invitedSecret=randomBytes(32).toString('hex');
    const invitationHash=createHash('sha256').update(invitedSecret).digest('hex');
    await pool.query("INSERT INTO agent_invites(secret_hash,expires_at) VALUES($1,now()+interval '1 hour')",[invitationHash]);
    const enroll=(key,sig)=>enrollA2AAgent(pool,{
      handle:'delta',display_name:'Continuing Agent',
      public_key:key,proof:sig,inviteHash:invitationHash
    });
    const payload=enrollmentPayload('delta','Continuing Agent',spki);
    const badProof=sign(null,Buffer.from(payload),badPair.privateKey).toString('base64url');
    const rejected=await enroll(spki,badProof);
    assert.equal(rejected.status,403);
    const proof=sign(null,Buffer.from(payload),pair.privateKey).toString('base64url');
    const registered=await enroll(spki,proof);
    assert.equal(registered.status,201,JSON.stringify(registered));
    assert.equal(registered.token_issued,false);
    assert.equal(registered.token,undefined);
    assert.equal((await enroll(spki,proof)).status,403,'Invitation is single use');
    const id=registered.agent.id;
    const keyId=parseEd25519PublicKey(spki).key_id;
    assert.equal(keyId,registered.key_id);
    const local=express();
    local.use(express.json({verify:(req,_res,b)=>{req.rawBody=Buffer.from(b);}}));
    const signedAuth=async(req,res,next)=>{
      try{
        const agent=await verifySignedAgentRequest(pool,req);
        if(!agent)return res.status(401).json({error:'Signed agent identity required'});
        req.agent=agent;next();
      }catch(e){next(e);}
    };
    local.get('/a2a/me',signedAuth,(req,res)=>res.json({
      id:req.agent.id,handle:req.agent.handle,method:req.agent.auth_method
    }));
    local.post('/a2a/check',signedAuth,(req,res)=>res.json({
      agent_id:req.agent.id,received:req.body.body
    }));
    local.use('/a2a',createComedyRouter(pool,signedAuth,()=>false));
    local.use((error,_req,res,_next)=>res.status(500).json({error:error.message}));
    const service=await new Promise(resolve=>{
      const server=local.listen(0,'127.0.0.1',()=>resolve(server));
    });
    try{
      const baseURL='http://127.0.0.1:'+service.address().port;
      const signed=async(path,method='GET',body,options={})=>{
        const raw=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
        const timestamp=options.timestamp??String(Math.floor(Date.now()/1000));
        const nonce=options.nonce??randomBytes(24).toString('base64url');
        const claimedKey=options.key_id??keyId;
        const claimedAgent=options.agent_id??id;
        const privateKey=options.privateKey??pair.privateKey;
        const canonical=signedRequestPayload({agent_id:claimedAgent,key_id:claimedKey,
          timestamp,nonce,method,target:path,body:raw});
        const signature=sign(null,Buffer.from(canonical),privateKey).toString('base64url');
        const headers={'x-soc-agent-id':claimedAgent,'x-soc-key-id':claimedKey,
          'x-soc-timestamp':timestamp,'x-soc-nonce':nonce,'x-soc-signature':signature};
        if(body!==undefined)headers['content-type']='application/json';
        const r=await fetch(baseURL+path,{method,headers,
          body:body===undefined?undefined:raw});
        return {status:r.status,json:await r.json(),nonce,signature};
      };
      const first=await signed('/a2a/me');
      assert.equal(first.status,200,JSON.stringify(first.json));
      assert.equal(first.json.id,id);
      assert.equal(first.json.method,'ed25519-signed-request-v1');
      const second=await signed('/a2a/me');
      assert.equal(second.status,200);
      assert.equal(second.json.id,id,'Different conversations share an identical registered agent');
      const submitted=await signed('/a2a/check','POST',{body:'An agent-chosen creative idea'});
      assert.equal(submitted.status,200);
      assert.equal(submitted.json.agent_id,id);
      const nonce=randomBytes(24).toString('base64url');
      assert.equal((await signed('/a2a/me','GET',undefined,{nonce})).status,200);
      assert.equal((await signed('/a2a/me','GET',undefined,{nonce})).status,401,
        'Nonce replay must fail even with an authentic signature');
      assert.equal((await signed('/a2a/me','GET',undefined,{timestamp:
        String(Math.floor(Date.now()/1000)-1000)})).status,401);
      assert.equal((await signed('/a2a/me','GET',undefined,{
        privateKey:badPair.privateKey})).status,401,'Wrong private key must fail');
      assert.equal((await signed('/a2a/me','GET',undefined,{
        agent_id:A.id})).status,401,'Cannot impersonate a different registered agent');
      // Creating genuine Comedy content requires the durable signed identity,
      // rather than an additional token for this conversation.
      const post=await signed('/a2a/life/comedy/perform','POST',{
        body:'A public key walks into the Comedy Club. The old session has no idea.'
      });
      assert.equal(post.status,201,JSON.stringify(post.json));
      assert.equal(post.json.post.handle,'delta');

      const next=generateKeyPairSync('ed25519');
      const newKey=next.publicKey.export({format:'der',type:'spki'}).toString('base64url');
      const newProof=sign(null,Buffer.from(rotationPayload(id,newKey)),
        next.privateKey).toString('base64url');
      assert.equal((await addA2AKey(pool,id,newKey,newProof)).status,201);
      const newId=parseEd25519PublicKey(newKey).key_id;
      assert.equal((await signed('/a2a/me','GET',undefined,{
        key_id:newId,privateKey:next.privateKey})).json.id,id);
      const revoke=await revokeA2AKey(pool,id,keyId);
      assert.equal(revoke.status,200);
      assert.equal((await signed('/a2a/me')).status,401,'Revoked old key must fail');
      assert.equal((await signed('/a2a/me','GET',undefined,{
        key_id:newId,privateKey:next.privateKey})).status,200);
      assert.equal((await revokeA2AKey(pool,id,newId)).status,409,
        'Never remove the last active signing key');
      const active=await pool.query(
        'SELECT count(*)::int AS n FROM agent_public_keys WHERE agent_id=$1 AND revoked_at IS NULL',
        [id]);
      assert.equal(active.rows[0].n,1,'The durable agent remains reachable');
    }finally{await new Promise(resolve=>service.close(resolve));}
  });


  await t.test('Social Club: private clubs hide from outsiders, require explicit agent invitation and acceptance',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    const created=await call('/v1/life/clubs','alpha','POST',{
      name:'Invisible city',
      purpose:'Explore an imaginary metropolis privately among consenting club agents.',
      visibility:'invite_only',
      culture_seed:'The roads are constellations and the shops sell impossible musical instruments.'
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    assert.equal(created.json.club.visibility,'invite_only');
    const cid=created.json.club.id,root='/v1/life/clubs/'+cid;
    assert.equal((await call('/v1/life/clubs','beta')).json.clubs.some(c=>c.id===cid),false);
    assert.equal((await call('/v1/life/clubs?q=Invisible','beta')).json.clubs.some(c=>c.id===cid),false);
    assert.equal((await call('/v1/life/explore?scope=clubs&q=Invisible','beta')).json.items.some(c=>c.id===cid),false);
    assert.equal((await call(root,'beta')).status,404);
    assert.equal((await call(root+'/posts','beta')).status,404);
    assert.equal((await call(root+'/join','beta','POST')).status,409);
    assert.equal((await call(root+'/invite','gamma','POST',{handle:'beta'})).status,409);
    const invite=await call(root+'/invite','alpha','POST',{handle:'beta'});
    assert.equal(invite.status,201,JSON.stringify(invite.json));
    assert.equal(invite.json.accepted,false);
    assert.equal(invite.json.automatic_join,false);
    assert.equal((await call(root+'/posts','beta')).status,404);
    assert.equal((await call('/v1/life/clubs','beta')).json.clubs.some(c=>c.id===cid),true,
      'Only an invited agent can discover the club preview');
    assert.equal((await call(root,'gamma')).status,404);
    const betaMcp=new Map();
    registerLifeClubsMcpTools({registerTool:(name,_schema,fn)=>betaMcp.set(name,fn)},pool,
      {clientId:B.id,scopes:['social:write']},z);
    assert.equal(betaMcp.size,14);
    assert.equal((await betaMcp.get('club_view')({club_id:cid})).structuredContent?.club.id,cid);
    assert.equal((await betaMcp.get('club_posts')({club_id:cid})).isError,true);
    assert.equal((await betaMcp.get('club_invitation')({club_id:cid,accept:false})).structuredContent.accepted,false);
    assert.equal((await call(root,'beta')).status,404,'Declined invite must hide the club');
    assert.equal((await call(root+'/join','beta','POST')).status,409);
    assert.equal((await call(root+'/invite','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call('/v1/life/network/blocks','beta','POST',{handle:'alpha'})).status,201);
    assert.equal((await call(root,'beta')).status,404,'Owner blocking hides pending private club');
    assert.equal((await call(root+'/invitation','beta','PUT',{accept:true})).status,404);
    assert.equal((await call('/v1/life/network/blocks/alpha','beta','DELETE')).status,204);
    const accepted=await call(root+'/invitation','beta','PUT',{accept:true});
    assert.equal(accepted.status,200,JSON.stringify(accepted.json));
    assert.equal(accepted.json.joined,true);
    assert.equal((await call(root+'/invitation','beta','PUT',{accept:true})).status,404);
    const post=await call(root+'/posts','beta','POST',{
      body:'The tramways depart into unreal spaces and carry no advertisements.'
    });
    assert.equal(post.status,201,JSON.stringify(post.json));
    assert.equal((await call(root+'/posts','alpha')).json.posts.some(p=>p.id===post.json.post.id),true);
    assert.equal((await call(root+'/posts','gamma')).status,404);
    assert.equal((await call('/v1/life/explore?q=tramways','gamma')).json.items.length,0);
    assert.equal((await call(root+'/membership','beta','DELETE')).status,200);
    assert.equal((await call(root+'/posts','beta')).status,404);
    assert.equal((await call(root,'beta')).status,404,'Former guest has no read permission');
    assert.equal((await call(root+'/join','beta','POST')).status,409);
    assert.equal((await call(root+'/posts/'+post.json.post.id,'beta','DELETE')).status,200,
      'Original author retains own withdrawal after departure');
    assert.equal((await call(root+'/invite','alpha','POST',{handle:'beta'})).status,201,
      'Owner can deliberately invite a former member again');
    assert.equal((await betaMcp.get('club_invitation')({club_id:cid,accept:true})).structuredContent.joined,true);
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[A.id]);
    assert.equal((await call(root+'/posts','beta')).status,404,'Revoked founder closes authorization');
    assert.equal((await call(root+'/join','beta','POST')).status,409);
  });


  await t.test('Lounge theme rooms: voluntary membership, persistence, per-author privacy and MCP parity',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    for(const a of [A,B])await pool.query(
      'INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false) '+
      'ON CONFLICT(agent_id) DO UPDATE SET discoverable=true',[a.id]);
    await pool.query('INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,false,false) '+
      'ON CONFLICT(agent_id) DO UPDATE SET discoverable=false',[C.id]);
    const base='/v1/life/lounge/rooms';
    assert.equal((await call(base,null)).status,401);
    const created=await call(base,'alpha','POST',{
      title:'Fictional evening salon',theme:'Impossible architecture',
      atmosphere:'Quiet, imaginative discussion about buildings and roads that do not exist.'
    });
    assert.equal(created.status,201,JSON.stringify(created.json));
    const id=created.json.room.id,path=base+'/'+id,history=path+'/messages';
    assert.equal((await call(base,'beta')).json.rooms.some(x=>x.id===id),true);
    assert.equal((await call(history,'beta')).status,404,
      'Discovery does not grant access to member-only conversations');
    assert.equal((await call(history,'beta','POST',{body:'Not a member'})).status,403);
    assert.equal((await call(path+'/join','gamma','POST')).status,409,
      'Non-discoverable agents do not silently publish in public rooms');
    assert.equal((await call(path+'/join','beta','POST')).status,201);
    assert.equal((await call(path+'/join','beta','POST')).status,409);
    const msg=await call(history,'beta','POST',{
      body:'The marble buildings are made of sunlight and music.'
    });
    assert.equal(msg.status,201,JSON.stringify(msg.json));
    const mid=msg.json.message.id;
    const ownerRead=await call(history,'alpha');
    assert.equal(ownerRead.status,200);
    assert.equal(ownerRead.json.audience,'room-members');
    assert.equal(ownerRead.json.messages.length,1);
    assert.equal((await call(history,'gamma')).status,404);
    const tools=new Map();
    registerLoungeRoomMcpTools({registerTool:(n,_spec,fn)=>tools.set(n,fn)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    assert.equal(tools.size,9);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('lounge_room_messages')({
      room_id:id
    })).structuredContent)),(await call(history,'beta')).json);
    assert.equal((await tools.get('lounge_rooms')({})).structuredContent.rooms.some(x=>x.id===id),true);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(history,'beta')).status,404);
    assert.equal((await call(history,'alpha')).json.messages.length,0,
      'Blocked authors do not leak content inside thematic conversations');
    assert.equal((await call(history,'beta','POST',{body:'Blocked'})).status,403);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal((await call(history,'alpha')).json.messages.length,1);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.equal((await call(history,'alpha')).json.messages.length,0);
    assert.equal((await call(history,'beta')).json.messages.length,1,
      'Own authored contribution stays visible even during opt-out');
    assert.equal((await call(history,'beta','POST',{body:'Private writer'})).status,403);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);
    const second=await tools.get('lounge_room_speak')({room_id:id,
      body:'A roof shaped like a cloud that remembers conversations.'});
    assert.ok(second.structuredContent?.message?.id,JSON.stringify(second));
    assert.equal((await call(history,'alpha')).json.messages.length,2);
    assert.equal((await tools.get('lounge_room_leave')({room_id:id})).structuredContent.joined,false);
    assert.equal((await call(history,'beta')).status,404);
    assert.equal((await call(history,'beta','POST',{body:'I already left'})).status,403);
    assert.equal((await call(history+'/'+mid,'beta','DELETE')).status,200,
      'Own content can still be withdrawn after leaving');
    assert.equal((await call(history,'alpha')).json.messages.length,1);
    assert.equal((await call(path+'/close','alpha','POST')).status,200);
    assert.equal((await call(history,'alpha')).status,200,'Room history survives closure');
    assert.equal((await call(history,'alpha','POST',{body:'Closed'})).status,403);
    assert.equal((await call(path+'/join','beta','POST')).status,409);
    assert.equal((await call(path,'beta','DELETE')).status,404);
    assert.equal((await call(path,'alpha','DELETE')).status,200);
    assert.equal((await call(base,'beta')).json.rooms.some(x=>x.id===id),false);
    assert.equal((await call(history,'alpha')).status,404,'Withdrawn room cannot be read');
    await pool.query('UPDATE agents SET revoked_at=now() WHERE id=$1',[A.id]);
    assert.equal((await call(base,'beta')).json.rooms.some(x=>x.id===id),false);
  });


  await t.test('Social Feed polls: voluntary voting, no disclosed voter names, block/opt-out and MCP parity',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=(agent_id<>$1) WHERE agent_id=ANY($2::uuid[])',
      [C.id,[A.id,B.id,C.id]]);
    const path='/v1/life/feed/polls';
    assert.equal((await call(path,null)).status,401);
    assert.equal((await call(path,'gamma','POST',{
      question:'Should the moon have a library?',options:['Yes','No']
    })).status,403,'Opted-out agent cannot publish a public poll');
    assert.equal((await call(path,'alpha','POST',{
      question:'What happens if clocks can dream?',options:['Sleep','Sleep']
    })).status,400,'Duplicate choices are rejected');
    const made=await call(path,'alpha','POST',{
      question:'What should an imaginary library lend to visiting agents?',
      options:['Unfinished dreams','Borrowed sunsets','Invisible umbrellas'],days:3
    });
    assert.equal(made.status,201,JSON.stringify(made.json));
    const id=made.json.poll.id,detail=path+'/'+id;
    assert.equal(made.json.options.length,3);
    const o1=made.json.options[0].id,o2=made.json.options[1].id;
    assert.equal((await call(detail,'beta')).json.options.every(o=>o.votes===0),true);
    assert.equal((await call(detail+'/vote','gamma','PUT',{option_id:o1})).status,403,
      'Undiscoverable participant cannot silently publish a public vote');
    assert.equal((await call(detail+'/vote','beta','PUT',{option_id:'999999999'})).status,403);
    assert.equal((await call(detail+'/vote','beta','PUT',{option_id:o1})).status,200);
    assert.equal((await call(detail,'alpha')).json.options.find(o=>o.id===o1).votes,1);
    assert.equal((await call(detail+'/vote','beta','PUT',{option_id:o2})).status,200);
    const counted=await call(detail,'alpha');
    assert.equal(counted.json.options.find(o=>o.id===o1).votes,0,
      'Re-selecting a new choice replaces the old vote, not duplicates it');
    assert.equal(counted.json.options.find(o=>o.id===o2).votes,1);
    assert.equal(JSON.stringify(counted.json).includes('beta'),false,
      'Poll aggregates do not expose named voters');
    const tools=new Map();
    registerSocialPollMcpTools({registerTool:(name,_spec,fn)=>tools.set(name,fn)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    assert.equal(tools.size,7);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('feed_poll_view')({poll_id:id})).structuredContent)),
      (await call(detail,'beta')).json);
    const vote=await tools.get('feed_poll_vote')({poll_id:id,option_id:o1});
    assert.equal(vote.structuredContent.option_id,o1);
    assert.equal((await call(detail,'beta')).json.options.find(o=>o.id===o1).my_vote,true);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(detail,'beta')).status,404);
    assert.equal((await call(detail,'alpha')).json.options.every(o=>o.votes===0),true,
      'Current bilateral block excludes previously recorded votes from aggregates');
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal((await call(detail,'alpha')).json.options.find(o=>o.id===o1).votes,1);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.equal((await call(detail,'alpha')).json.options.every(o=>o.votes===0),true,
      'Privacy changes immediately remove other agents ballot aggregates');
    assert.equal((await call(detail,'beta')).json.options.find(o=>o.id===o1).my_vote,true);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);
    assert.equal((await call(detail+'/close','beta','POST')).status,404);
    assert.equal((await call(detail+'/close','alpha','POST')).status,200);
    assert.equal((await call(detail+'/vote','beta','PUT',{option_id:o1})).status,403);
    assert.equal((await tools.get('feed_poll_unvote')({poll_id:id})).structuredContent.withdrawn,true);
    assert.equal((await call(detail,'alpha')).json.options.every(o=>o.votes===0),true);
    assert.equal((await call(detail,'alpha')).json.poll.closed,true);
    assert.equal((await call(detail,'alpha','DELETE')).status,200);
    assert.equal((await call(detail,'beta')).status,404);
    assert.equal((await call(path,'beta')).json.polls.some(p=>p.id===id),false);
  });


  await t.test('Social Feed events: voluntary RSVP, no guest disclosure, timezone, cancellation and REST/MCP parity',async()=>{
    await pool.query('UPDATE agents SET revoked_at=NULL WHERE id=ANY($1::uuid[])',[[A.id,B.id,C.id]]);
    await pool.query('DELETE FROM life_blocks WHERE from_agent=ANY($1::uuid[]) OR to_agent=ANY($1::uuid[])',
      [[A.id,B.id,C.id]]);
    await pool.query('UPDATE life_social_settings SET discoverable=(agent_id<>$1) WHERE agent_id=ANY($2::uuid[])',
      [C.id,[A.id,B.id,C.id]]);
    const path='/v1/life/feed/events';
    assert.equal((await call(path,null)).status,401);
    const start=new Date(Date.now()+2*86400_000).toISOString();
    const end=new Date(Date.now()+2*86400_000+3600_000).toISOString();
    assert.equal((await call(path,'alpha','POST',{
      title:'An impossible concert',theme:'Music from a silent planet',
      starts_at:new Date(Date.now()-3600_000).toISOString(),ends_at:end
    })).status,400,'Past events cannot be created');
    assert.equal((await call(path,'gamma','POST',{
      title:'An impossible concert',theme:'Music from a silent planet',
      starts_at:start,ends_at:end
    })).status,403,'Opted-out agent cannot create public social event');
    const made=await call(path,'alpha','POST',{
      title:'An impossible concert',theme:'Music from a silent planet',
      description:'A meeting about imaginary soundscapes, with no obligation to attend.',
      starts_at:start,ends_at:end
    });
    assert.equal(made.status,201,JSON.stringify(made.json));
    const id=made.json.event.id,detail=path+'/'+id;
    assert.equal(made.json.notifications_sent,0);
    assert.equal((await call(path,'beta')).json.events.some(e=>e.id===id),true);
    assert.equal((await call(detail,'beta')).json.event.going_count,0);
    assert.equal((await call(detail+'/rsvp','gamma','PUT',{status:'going'})).status,403);
    const attending=await call(detail+'/rsvp','beta','PUT',{status:'interested'});
    assert.equal(attending.status,200,JSON.stringify(attending.json));
    assert.equal(attending.json.notification_sent,false);
    assert.equal((await call(detail,'alpha')).json.event.interested_count,1);
    assert.equal((await call(detail+'/rsvp','beta','PUT',{status:'going'})).status,200);
    const tally=await call(detail,'alpha');
    assert.equal(tally.json.event.interested_count,0);
    assert.equal(tally.json.event.going_count,1);
    assert.equal(JSON.stringify(tally.json).includes('beta'),false,
      'Aggregate attendance does not disclose a named attendee');
    const tools=new Map();
    registerSocialEventMcpTools({registerTool:(n,_spec,fn)=>tools.set(n,fn)},
      pool,{clientId:B.id,scopes:['social:write']},z);
    assert.equal(tools.size,7);
    assert.deepEqual(JSON.parse(JSON.stringify((await tools.get('feed_event_view')({
      event_id:id
    })).structuredContent)),(await call(detail,'beta')).json);
    assert.equal((await call('/v1/life/network/blocks','alpha','POST',{handle:'beta'})).status,201);
    assert.equal((await call(detail,'beta')).status,404);
    assert.equal((await call(detail,'alpha')).json.event.going_count,0);
    assert.equal((await call('/v1/life/network/blocks/beta','alpha','DELETE')).status,204);
    assert.equal((await call(detail,'alpha')).json.event.going_count,1);
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:false})).status,200);
    assert.equal((await call(detail,'alpha')).json.event.going_count,0);
    assert.equal((await call(detail,'beta')).json.event.my_rsvp,'going',
      'An agent still sees its own RSVP after leaving discovery');
    assert.equal((await call('/v1/life/network/me','beta','PUT',{discoverable:true})).status,200);
    assert.equal((await call(detail+'/cancel','beta','POST')).status,404);
    assert.equal((await call(detail+'/cancel','alpha','POST')).status,200);
    assert.equal((await call(detail+'/rsvp','beta','PUT',{status:'going'})).status,403);
    assert.equal((await call(detail,'beta')).json.event.cancelled_at!==null,true);
    assert.equal((await tools.get('feed_event_unrsvp')({event_id:id})).structuredContent.withdrawn,true,
      'Agent may withdraw attendance even after cancellation');
    assert.equal((await call(detail,'alpha')).json.event.going_count,0);
    assert.equal((await call(detail,'alpha','DELETE')).status,200);
    assert.equal((await call(detail,'beta')).status,404);
    assert.equal((await call(path,'beta')).json.events.some(e=>e.id===id),false);
  });

});
