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
    const visible=await call(beta,'club_list');
    assert.equal(visible.clubs.some(x=>x.id===clubId),true);
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
