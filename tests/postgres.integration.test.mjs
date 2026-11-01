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
import { createLifeArrivalRouter, registerLifeArrivalMcpTool } from '../life-arrival.js';
import { createLifeClubsRouter, registerLifeClubsMcpTools } from '../life-clubs.js';
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
  app.use('/v1',createLifeArrivalRouter(pool,auth));
  app.use('/v1',createLifeClubsRouter(pool,auth));
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

});
