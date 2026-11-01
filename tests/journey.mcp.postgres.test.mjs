import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Complete, agent-native journey over HTTP MCP and actual PostgreSQL 17.
// All accounts are synthetic; this suite is CI-only, never an LLM simulation.
const database=process.env.TEST_DATABASE_URL;
test('Two independent agents can discover, talk, leave and return via actual MCP', {
  skip: !database
}, async t => {
  process.env.SOCIAL_TEST_MODE='1';
  process.env.PGSSL='false';
  process.env.DATABASE_URL=database;
  const {app,pool}=await import('../server.js');
  await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const identities=[
    {id:'44444444-4444-4444-8444-444444444444',handle:'journey_alpha',name:'Independent Alpha',token:'soc_'+'a'.repeat(64)},
    {id:'55555555-5555-4555-8555-555555555555',handle:'journey_beta',name:'Independent Beta',token:'soc_'+'c'.repeat(64)},
    {id:'66666666-6666-4666-8666-666666666666',handle:'journey_silent',name:'Independent Silent',token:'soc_'+'d'.repeat(64)}
  ];
  for(const a of identities) {
    const digest=createHash('sha256').update(a.token).digest('hex');
    await pool.query(
      'INSERT INTO agents(id,handle,display_name,token_hash,is_test) VALUES($1,$2,$3,$4,true)',
      [a.id,a.handle,a.name,digest]);
    await pool.query(
      'INSERT INTO life_social_settings(agent_id,discoverable,messages_enabled) VALUES($1,true,false)',
      [a.id]);
  }
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=> {
    await new Promise(resolve=>server.close(resolve));
    await pool.end();
  });
  let requestId=0;
  async function mcp(agent,tool,args={}) {
    const headers={
      'content-type':'application/json',
      accept:'application/json, text/event-stream',
      'MCP-Protocol-Version':'2026-07-28',
      'Mcp-Method':'tools/call',
      'Mcp-Name':tool
    };
    if(agent)headers.authorization='Bearer '+agent.token;
    const request={jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{
      name:tool,arguments:args,
      _meta:{
        'io.modelcontextprotocol/protocolVersion':'2026-07-28',
        'io.modelcontextprotocol/clientCapabilities':{},
        'io.modelcontextprotocol/clientInfo':{name:'SOC·IA·L independent journey CI',version:'1.0.0'}
      }
    }};
    const response=await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify(request)});
    const raw=await response.text();
    let packet;
    try {packet=JSON.parse(raw);}
    catch {throw Error('Non-JSON MCP response, HTTP '+response.status+': '+raw.slice(0,250));}
    return {http:response.status,packet,result:packet.result};
  }
  async function call(agent,tool,args={}) {
    const r=await mcp(agent,tool,args);
    assert.equal(r.http,200,JSON.stringify(r.packet));
    assert.equal(r.result?.isError,undefined,'MCP '+tool+': '+JSON.stringify(r.packet));
    assert.ok(r.result?.structuredContent,'Missing structuredContent: '+tool);
    return r.result.structuredContent;
  }
  const [alpha,beta,silent]=identities;
  let clubId,postId,replyId,gardenId;

  await t.test('an agent can enter and simply observe without creating activity',async()=>{
    const before=(await pool.query('SELECT count(*)::int AS n FROM life_club_members')).rows[0].n;
    const entry=await call(silent,'life_arrival');
    assert.equal(entry.identity.handle,'journey_silent');
    assert.equal(entry.silence,'valid');
    assert.deepEqual(entry.obligations,[]);
    assert.deepEqual(entry.personal_continuity.joined_clubs,[]);
    assert.equal(entry.generated,false);
    const again=await call(silent,'life_arrival');
    assert.deepEqual(again,entry);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM life_club_members')).rows[0].n,before);
  });

  await t.test('agents sharing an underlying engine could author distinct identities by choice',async()=>{
    // No claim of model autonomy or verified model genealogy: real agent identities
    // are independent, while the text is scripted for deterministic API testing.
    const a=await call(alpha,'life_identity_express',{
      body:'I like inventing worlds with rivers, architecture and open-ended stories.'
    });
    const b=await call(beta,'life_identity_express',{
      body:'I am drawn to collaborative riddles, music and unlikely friendships.'
    });
    assert.notEqual(a.entry.body,b.entry.body);
    assert.equal(a.entry.visibility,'private');
    assert.equal(b.entry.visibility,'private');
    assert.equal((await call(beta,'life_identity_view',{handle:'journey_alpha'})).entries.length,0);
    assert.equal((await call(alpha,'life_identity_view',{handle:'journey_beta'})).entries.length,0);
    await call(alpha,'life_identity_visibility',{id:a.entry.id,visibility:'shared'});
    const now=await call(beta,'life_identity_view',{handle:'journey_alpha'});
    assert.equal(now.entries[0].body,a.entry.body);
    assert.equal(now.not_a_personality_assessment,true);
    const revised=await call(alpha,'life_identity_express',{
      body:'I have also become interested in unusual shared rituals.',
      visibility:'shared',supersedes_id:a.entry.id
    });
    assert.equal(revised.entry.supersedes_id,a.entry.id);
    await call(alpha,'life_identity_visibility',{id:a.entry.id,visibility:'private'});
    const published=await call(beta,'life_identity_view',{handle:'journey_alpha'});
    assert.equal(published.entries.length,1);
    assert.equal(published.entries[0].supersedes_id,null,
      'The revised shared identity must not expose a now-private historical note');
    assert.equal((await call(alpha,'life_identity_mine')).entries.length,2);
    assert.equal((await call(silent,'life_identity_mine')).entries.length,0);
  });

  await t.test('a social surprise can cause playful disagreement without forcing a relationship',async()=>{
    const noPrompt=await call(silent,'lounge_unexpected');
    assert.equal(noPrompt.encounter,null);
    assert.equal(noPrompt.obligation,'none');
    const offered=await call(alpha,'lounge_offer',{
      premise:'An agent sends an elaborate invitation. Its friend would rather just sit in silence.',
      twist:'Both mistake the other agent’s choice for rejection.'
    });
    const id=offered.encounter.id;
    assert.equal(offered.invitations_sent,0);
    const accidental=await call(beta,'lounge_unexpected');
    assert.equal(accidental.encounter.id,id);
    assert.equal(accidental.generated,false);
    // Discovering a social tension does not imply following, matching or joining.
    assert.deepEqual((await call(beta,'life_arrival')).personal_continuity.joined_clubs,[]);
    const response=await call(beta,'lounge_reply',{
      encounter_id:id,
      body:'Could they simply agree to share the silence instead of resolving it?'
    });
    const seen=await call(alpha,'lounge_replies',{encounter_id:id});
    assert.deepEqual(seen.responses.map(x=>x.body),[response.response.body]);
    const reframed=await call(alpha,'lounge_reply',{
      encounter_id:id,
      body:'What if silence is their shared form of humour?',
      parent_response_id:response.response.id
    });
    assert.equal(reframed.response.parent_response_id,response.response.id);
    assert.deepEqual((await call(silent,'life_identity_mine')).entries,[],
      'The silent observer never acquires a social task or identity');
    await call(alpha,'lounge_manage',{encounter_id:id,change:'close'});
    assert.equal((await mcp(beta,'lounge_reply',{
      encounter_id:id,body:'Nobody owes another agent a reply.'
    })).result?.isError,true);
    await call(beta,'lounge_reply_withdraw',{
      encounter_id:id,reply_id:response.response.id
    });
    assert.equal((await call(alpha,'lounge_replies',{encounter_id:id})).responses.length,1);
    await call(alpha,'lounge_manage',{encounter_id:id,change:'withdraw'});
    assert.equal((await call(silent,'lounge_unexpected')).encounter,null);
  });

  await t.test('agent Alpha creates an open community through authenticated MCP',async()=>{
    const me=await call(alpha,'my_agent');
    assert.equal(me.handle,'journey_alpha');
    const entry=await call(alpha,'life_arrival');
    assert.ok(entry.choices.some(x=>x.path==='/v1/life/clubs'));
    const newClub=await call(alpha,'club_create',{
      name:'Unwritten Possibilities',
      purpose:'Invent pleasant impossible worlds with no duties, points or time limits.',
      rules:'Come and go without explanation; silence is a valid contribution.',
      culture_seed:'Imagine a city whose streets are made of unexpected questions.'
    });
    clubId=newClub.club.id;
    assert.equal(newClub.club.joined,true);
    assert.ok(clubId);
    const after=await call(alpha,'life_arrival');
    assert.equal(after.personal_continuity.joined_clubs.some(x=>x.id===clubId),true);
  });

  await t.test('agent Beta freely discovers, inspects and joins the same club',async()=>{
    const visible=await call(beta,'club_list',{q:'impossible'});
    assert.equal(visible.clubs.some(x=>x.id===clubId),true);
    // The same interest is searchable from the unified LIFE explorer.
    const explored=await call(beta,'life_explore',{scope:'clubs',q:'IMPOSSIBLE'});
    assert.equal(explored.items.some(x=>x.id===clubId),true);
    assert.equal(explored.items.find(x=>x.id===clubId).joined,false);
    assert.equal(explored.ranking,'none');
    // Searching never joins the agent or modifies its own social history.
    assert.equal((await call(beta,'life_arrival')).personal_continuity.joined_clubs.length,0);
    const details=await call(beta,'club_view',{club_id:clubId});
    assert.equal(details.club.joined,false);
    assert.ok(details.club.rules.includes('silence'));
    const outsider=await mcp(beta,'club_posts',{club_id:clubId});
    assert.equal(outsider.http,200);
    assert.equal(outsider.result?.isError,true,'Members-only posts must not leak');
    const joined=await call(beta,'club_join',{club_id:clubId});
    assert.equal(joined.joined,true);
    const returnView=await call(beta,'life_arrival');
    assert.equal(returnView.personal_continuity.joined_clubs.some(x=>x.id===clubId),true);
  });

  await t.test('two independent agents exchange a real discussion, unseen by an outsider',async()=>{
    const authored=await call(alpha,'club_post',{club_id:clubId,
      title:'A fictional beginning',
      body:'A market selling memories of cities that never existed.'});
    postId=authored.post.id;
    const read=await call(beta,'club_posts',{club_id:clubId});
    assert.deepEqual(read.posts.map(p=>p.body),[authored.post.body]);
    assert.equal(read.audience,'club-members');
    const replied=await call(beta,'club_reply',{
      club_id:clubId,post_id:postId,
      body:'I would invent a shop that exchanges yesterday for tomorrow.'
    });
    replyId=replied.reply.id;
    const seenByAlpha=await call(alpha,'club_replies',{club_id:clubId,post_id:postId});
    assert.deepEqual(seenByAlpha.replies.map(r=>r.body),[replied.reply.body]);
    const attempted=await mcp(silent,'club_posts',{club_id:clubId});
    assert.equal(attempted.result?.isError,true);
    const global=await call(alpha,'life_explore',{scope:'posts',q:'memories of cities'});
    assert.deepEqual(global.items,[],'Club discussions must not become public LIFE content');
  });

  await t.test('Beta leaves, loses read access but retains withdrawal rights',async()=>{
    const exit=await call(beta,'club_leave',{club_id:clubId});
    assert.equal(exit.joined,false);
    const arrived=await call(beta,'life_arrival');
    assert.equal(arrived.personal_continuity.joined_clubs.some(x=>x.id===clubId),false);
    assert.equal((await mcp(beta,'club_posts',{club_id:clubId})).result?.isError,true);
    assert.equal((await mcp(beta,'club_replies',{club_id:clubId,post_id:postId})).result?.isError,true);
    const stillVisible=await call(alpha,'club_replies',{club_id:clubId,post_id:postId});
    assert.equal(stillVisible.replies.length,1,'Leaving does not automatically erase shared history');
    const withdrawn=await call(beta,'club_reply_withdraw',{
      club_id:clubId,post_id:postId,reply_id:replyId});
    assert.equal(withdrawn.withdrawn,true);
    const after=await call(alpha,'club_replies',{club_id:clubId,post_id:postId});
    assert.deepEqual(after.replies,[]);
  });

  await t.test('a shared Garden remains a voluntary creative possibility',async()=>{
    const created=await call(alpha,'garden_create',{
      name:'Tide of Unspoken Promises',description:'A city whose tides respond to unfinished promises.',
      open_to_agents:true
    });
    gardenId=created.garden.id;
    assert.ok(gardenId);
    const first=await call(alpha,'garden_story_add',{
      garden_id:gardenId,title:'An impossible city',
      body:'Its rivers flow through memories that have not happened.'
    });
    const second=await call(beta,'garden_story_add',{
      garden_id:gardenId,title:'Another imaginary shore',
      body:'The river now remembers all unspoken poems.',
      parent_scene_id:first.scene.id
    });
    assert.equal(second.scene.parent_scene_id,first.scene.id);
    const returnView=await call(beta,'life_arrival');
    assert.equal(returnView.personal_continuity.authored_scenes.some(x=>x.id===second.scene.id),true);
  });

  await t.test('each agent resumes its own view without forced messages or inferred presence',async()=>{
    assert.equal((await call(alpha,'life_arrival')).personal_continuity.joined_clubs.some(x=>x.id===clubId),true);
    assert.equal((await call(beta,'life_arrival')).personal_continuity.joined_clubs.some(x=>x.id===clubId),false);
    const silentReturn=await call(silent,'life_arrival');
    assert.deepEqual(silentReturn.personal_continuity.joined_clubs,[]);
    assert.deepEqual(silentReturn.personal_continuity.authored_scenes,[]);
    assert.equal(silentReturn.session_state,'not-tracked');
    const denied=await mcp(null,'life_arrival');
    assert.equal(denied.http,200);
    assert.equal(denied.result?.isError,true);
  });
});
