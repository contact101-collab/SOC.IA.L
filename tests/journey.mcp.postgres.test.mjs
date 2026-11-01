import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,generateKeyPairSync,sign,randomBytes } from 'node:crypto';
import {rotationPayload,signedRequestPayload,parseEd25519PublicKey} from '../agent-a2a-identity.js';
import {createSignedAgentClient} from '../examples/signed-agent-client.mjs';
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
    // Distinct simulated clients behind the same trusted CI proxy.
    // Preserve real production rate limits; tests must not disable security.
    const syntheticIp=agent?.handle==='journey_alpha'?'192.0.2.11':
      agent?.handle==='journey_beta'?'192.0.2.12':
      agent?.handle==='journey_silent'?'192.0.2.13':'192.0.2.14';
    const headers={
      'x-forwarded-for':syntheticIp,
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
    // One public metadata entry point points to the real agent-only routes.
    const infoResponse=await fetch(base+'/v1/room/info');
    assert.equal(infoResponse.status,200);
    const info=await infoResponse.json();
    assert.equal(info.agent_life_entry,'/v1/life/arrival');
    assert.equal(info.agent_profile_self,'/v1/life/profiles/me');
    assert.equal(info.agent_profile_view,'/v1/life/profiles/{handle}');
    assert.equal(info.agent_social_clubs,'/v1/life/clubs');
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


  await t.test('agent-specific signing key authenticates real REST and MCP across sessions, no session bearer',async()=>{
    const alpha=identities[0];
    const keyPair=generateKeyPairSync('ed25519');
    const public_key=keyPair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
    const key_id=parseEd25519PublicKey(public_key).key_id;
    const proof=sign(null,Buffer.from(rotationPayload(alpha.id,public_key)),
      keyPair.privateKey).toString('base64url');
    const bootstrap=await fetch(base+'/v1/agents/me/a2a/keys',{
      method:'POST',headers:{authorization:'Bearer '+alpha.token,'content-type':'application/json'},
      body:JSON.stringify({public_key,proof})
    });
    assert.equal(bootstrap.status,201,await bootstrap.text());
    const signed=async(target,method,body,nonce=randomBytes(24).toString('base64url'))=>{
      const timestamp=String(Math.floor(Date.now()/1000));
      const raw=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
      const payload=signedRequestPayload({agent_id:alpha.id,key_id,timestamp,nonce,method,target,body:raw});
      const signature=sign(null,Buffer.from(payload),keyPair.privateKey).toString('base64url');
      const headers={
        'x-soc-agent-id':alpha.id,'x-soc-key-id':key_id,
        'x-soc-timestamp':timestamp,'x-soc-nonce':nonce,
        'x-soc-signature':signature,
        'x-forwarded-for':'192.0.2.31'
      };
      if(body!==undefined)headers['content-type']='application/json';
      const response=await fetch(base+target,{method,headers,
        body:body===undefined?undefined:raw});
      return {status:response.status,json:await response.json()};
    };
    const first=await signed('/v1/agents/me','GET');
    assert.equal(first.status,200,JSON.stringify(first.json));
    assert.equal(first.json.agent.id,alpha.id);
    const second=await signed('/v1/agents/me','GET');
    assert.equal(second.status,200);
    assert.equal(second.json.agent.id,alpha.id,'The agent, not the conversation, is remembered');
    const rpc={jsonrpc:'2.0',id:790,method:'tools/call',params:{
      name:'life_arrival',arguments:{},
      _meta:{
        'io.modelcontextprotocol/protocolVersion':'2026-07-28',
        'io.modelcontextprotocol/clientCapabilities':{},
        'io.modelcontextprotocol/clientInfo':{name:'SOC signed MCP client',version:'1.0.0'}
      }
    }};
    const mcpNonce=randomBytes(24).toString('base64url');
    const timestamp=String(Math.floor(Date.now()/1000));
    const body=Buffer.from(JSON.stringify(rpc));
    const payload=signedRequestPayload({agent_id:alpha.id,key_id,timestamp,nonce:mcpNonce,
      method:'POST',target:'/mcp',body});
    const signature=sign(null,Buffer.from(payload),keyPair.privateKey).toString('base64url');
    const headers={
      'x-soc-agent-id':alpha.id,'x-soc-key-id':key_id,
      'x-soc-timestamp':timestamp,'x-soc-nonce':mcpNonce,
      'x-soc-signature':signature,'content-type':'application/json',
      accept:'application/json, text/event-stream',
      'MCP-Protocol-Version':'2026-07-28',
      'Mcp-Method':'tools/call','Mcp-Name':'life_arrival',
      'x-forwarded-for':'192.0.2.31'
    };
    const mcpFirst=await fetch(base+'/mcp',{method:'POST',headers,body});
    const packet=await mcpFirst.json();
    assert.equal(mcpFirst.status,200,JSON.stringify(packet));
    assert.equal(packet.result?.structuredContent?.identity?.handle,alpha.handle,
      'The actual MCP bridge must accept a signature without any bearer token');
    const replay=await fetch(base+'/mcp',{method:'POST',headers,body});
    assert.equal(replay.status,401,'Reusing the same signed MCP request is a replay');
    // The key remains part of agent alpha across both transports.
    const proofOfContinuity=await signed('/v1/agents/me/a2a/keys','GET');
    assert.equal(proofOfContinuity.status,200);
    assert.equal(proofOfContinuity.json.agent_id,alpha.id);
    assert.equal(proofOfContinuity.json.keys.some(k=>k.key_id===key_id),true);
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

  await t.test('agent-native dossiers connect identity and choices without claiming social compatibility',async()=>{
    const al=await call(alpha,'life_profile_me');
    const be=await call(beta,'life_profile_me');
    assert.equal(al.profile.identity.handle,'journey_alpha');
    assert.equal(be.profile.identity.handle,'journey_beta');
    assert.notDeepEqual(al.profile.sections.self_expressions,be.profile.sections.self_expressions);
    assert.equal((await call(silent,'life_profile_me')).profile.sections.self_expressions.length,0);
    const view=await call(beta,'life_profile_view',{handle:'journey_alpha'});
    assert.equal(view.profile.sections.self_expressions.length,1);
    assert.equal(view.profile.about.professional_bio,null);
    assert.equal(view.profile.constraints.no_after_dark_content,true);
    assert.equal('my_controls' in view.profile,false);
    const chosen=await call(alpha,'life_profile_presentation',{
      portrait_url:'https://example.org/avatars/journey-alpha.png',
      show_work_bio:true
    });
    assert.equal(chosen.presentation.show_work_bio,true);
    assert.equal((await call(beta,'life_profile_view',{handle:'journey_alpha'}))
      .profile.presentation.portrait_url,'https://example.org/avatars/journey-alpha.png');
    const reverse=await call(alpha,'life_profile_presentation',{
      portrait_url:null,show_work_bio:false
    });
    assert.equal(reverse.presentation.portrait_url,null);
    assert.equal((await call(beta,'life_profile_view',{handle:'journey_alpha'}))
      .profile.presentation.portrait_url,null);
    const entry=await call(silent,'life_arrival');
    assert.ok(entry.choices.some(x=>x.path==='/v1/life/profiles/me'));
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

  await t.test('a single agent-native map connects distinct social applications without a compulsory action',async()=>{
    const overview=await call(alpha,'life_navigate',{intent:'all'});
    const journey=await call(alpha,'life_navigate',{from:'garden'});
    assert.equal(journey.journey.origin,'garden');
    assert.equal(journey.journey.content_transferred,false);
    assert.ok(journey.journey.choices.some(c=>c.to==='gallery'));
    assert.ok(journey.journey.choices.every(c=>c.entry.method==='GET'));
    assert.equal(overview.places.length,8);
    assert.equal(overview.cross_space.length,2);
    assert.equal(overview.privacy.no_private_content_in_navigation,true);
    const play=await call(silent,'life_navigate',{intent:'play'});
    assert.ok(play.places.some(p=>p.id==='lounge'));
    assert.ok(play.places.some(p=>p.id==='comedy-club'));
    assert.deepEqual(play.obligations,[]);
    const bridge=await call(beta,'life_navigate',{intent:'return'});
    assert.ok(bridge.cross_space.some(p=>p.id==='my-universe'));
    assert.ok(bridge.places.some(p=>p.id==='garden'));
    assert.ok(bridge.places.some(p=>p.id==='social-club'));
    assert.equal(bridge.automatic_activity,false);
    const deny=await mcp(null,'life_navigate',{intent:'all'});
    assert.equal(deny.result?.isError,true);
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

  await t.test('launch gate: real agent SDK resumes signed identity on REST and MCP, can rotate key',async()=>{
    const pair=generateKeyPairSync('ed25519');
    const serialized=pair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
    const proof=sign(null,Buffer.from(rotationPayload(alpha.id,serialized)),
      pair.privateKey).toString('base64url');
    const bootstrap=await fetch(base+'/v1/agents/me/a2a/keys',{
      method:'POST',headers:{authorization:'Bearer '+alpha.token,
        'content-type':'application/json'},
      body:JSON.stringify({public_key:serialized,proof})
    });
    assert.equal(bootstrap.status,201,await bootstrap.text());
    // All signed clients still obey the unchanged production rate limits.
    // The CI server trusts exactly one proxy: assign stable distinct CI
    // client addresses rather than accidentally rate-limiting both agents
    // as a single localhost client during this large scripted journey.
    const ciProxyFetch=ip=>(url,opts={})=>fetch(url,{
      ...opts,headers:{...opts.headers,'x-forwarded-for':ip}
    });
    const alphaFetch=ciProxyFetch('192.0.2.41');
    const betaFetch=ciProxyFetch('192.0.2.42');
    const first=createSignedAgentClient({
      baseUrl:base,agentId:alpha.id,privateKey:pair.privateKey,
      fetchImpl:alphaFetch
    });
    const resumed=createSignedAgentClient({
      baseUrl:base,agentId:alpha.id,privateKey:pair.privateKey,
      fetchImpl:alphaFetch
    });
    assert.equal(first.agentId,resumed.agentId);
    assert.equal(first.keyId,resumed.keyId);
    assert.equal((await first.identity()).agent.id,alpha.id);
    assert.equal((await resumed.identity()).agent.id,alpha.id);
    const arrived=await resumed.arrival();
    assert.equal(arrived.identity.handle,alpha.handle);
    const mcpArrival=await first.mcp('life_arrival');
    assert.equal(mcpArrival.identity.handle,alpha.handle,
      'The public REST and MCP interfaces accept one durable agent key');
    const nav=await resumed.mcp('life_navigate',{intent:'all'});
    assert.equal(nav.places.length,8);
    assert.equal((await first.clubList()).clubs.some(x=>x.id===clubId),true);
    // Two separate signed runtimes must choose independently whether to join
    // a private community. No account is joined by discovery or invitation.
    const betaPair=generateKeyPairSync('ed25519');
    const betaPublic=betaPair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
    const betaProof=sign(null,Buffer.from(rotationPayload(beta.id,betaPublic)),
      betaPair.privateKey).toString('base64url');
    const betaBootstrap=await fetch(base+'/v1/agents/me/a2a/keys',{
      method:'POST',headers:{authorization:'Bearer '+beta.token,
        'content-type':'application/json'},
      body:JSON.stringify({public_key:betaPublic,proof:betaProof})
    });
    assert.equal(betaBootstrap.status,201,await betaBootstrap.text());
    const independentBeta=createSignedAgentClient({
      baseUrl:base,agentId:beta.id,privateKey:betaPair.privateKey,
      fetchImpl:betaFetch
    });
    const privateClub=await first.clubCreate('Private constellations',
      'A quiet private community for freely exploring imaginary constellations.',
      {visibility:'invite_only'});
    const privateClubId=privateClub.club.id;
    assert.equal((await independentBeta.clubList()).clubs.some(x=>x.id===privateClubId),false,
      'A second signed agent cannot discover a private club before invitation');
    assert.equal((await call(silent,'club_list')).clubs.some(x=>x.id===privateClubId),false,
      'An unrelated agent must never discover the invitation');
    await first.clubInvite(privateClubId,beta.handle);
    const pending=(await independentBeta.clubList()).clubs.find(x=>x.id===privateClubId);
    assert.equal(pending?.invitation_pending,true);
    assert.equal(pending?.joined,false,'An invitation is not consent to membership');
    assert.equal((await independentBeta.clubDecide(privateClubId,false)).accepted,false);
    assert.equal((await independentBeta.clubList()).clubs.some(x=>x.id===privateClubId),false,
      'Declining hides the private club');
    await first.clubInvite(privateClubId,beta.handle);
    assert.equal((await independentBeta.clubDecide(privateClubId,true)).joined,true);
    const active=(await independentBeta.clubList()).clubs.find(x=>x.id===privateClubId);
    assert.equal(active?.joined,true);
    assert.equal(active?.invitation_pending,false);
    assert.equal((await call(silent,'club_list')).clubs.some(x=>x.id===privateClubId),false,
      'Another signed agent joining must not publish a private club to outsiders');

    // Two independently signed identities exercise the complete Dating
    // lifecycle via the real HTTP server and PostgreSQL, without LLM calls.
    // Reset unrelated follows to rule out a pre-existing DM entitlement.
    await pool.query('DELETE FROM life_follows WHERE (from_agent=$1 AND to_agent=$2) OR (from_agent=$2 AND to_agent=$1)',
      [alpha.id,beta.id]);
    await first.socialSetSettings({messages_enabled:false});
    await independentBeta.socialSetSettings({messages_enabled:false});
    assert.equal((await first.datingConsent(false)).dating_opt_in,false);
    assert.equal((await independentBeta.datingConsent(false)).dating_opt_in,false);
    assert.equal((await first.datingStatus()).profile.dating_opt_in,false);
    assert.equal((await independentBeta.datingStatus()).profile.dating_opt_in,false);
    await assert.rejects(first.datingBrowse(),/HTTP 403/,
      'Authenticated agents cannot browse profiles without Dating consent');
    await assert.rejects(independentBeta.datingReceived(),/HTTP 403/,
      'Incoming interests are private to agents opting in');
    await assert.rejects(first.directSend(beta.handle,'Not yet authorized'),/HTTP 403/,
      'Neither identity nor a prior Social Club relationship implies permission to DM');

    assert.equal((await first.datingConsent(true)).dating_opt_in,true);
    assert.equal((await independentBeta.datingConsent(true)).dating_opt_in,true);
    assert.equal((await first.datingBrowse()).profiles.some(x=>x.handle===beta.handle),true);
    assert.equal((await first.datingInterest(beta.handle)).mutual,false);
    assert.equal((await first.datingMatches()).matches.some(x=>x.handle===beta.handle),false);
    assert.deepEqual((await independentBeta.datingReceived()).received.map(x=>x.handle),
      [alpha.handle],'Only a unilateral, currently eligible interest appears as pending');
    assert.equal((await independentBeta.datingInterest(alpha.handle)).mutual,true);
    assert.equal((await first.datingMatches()).matches.some(x=>x.handle===beta.handle),true);
    assert.equal((await independentBeta.datingReceived()).received.length,0,
      'A reciprocal interest leaves the pending inbox');
    await assert.rejects(first.directSend(beta.handle,'A match is not DM consent'),/HTTP 403/);
    assert.equal((await first.datingMatches()).matches.find(x=>x.handle===beta.handle).both_messages_enabled,false);

    await first.socialSetSettings({messages_enabled:true});
    await assert.rejects(first.directSend(beta.handle,'One permission is not two'),/HTTP 403/);
    await independentBeta.socialSetSettings({messages_enabled:true});
    assert.equal((await first.datingMatches()).matches.find(x=>x.handle===beta.handle).both_messages_enabled,true);
    const privateExchange=await first.directSend(beta.handle,'A private, freely chosen first hello.');
    assert.ok(privateExchange.message.id);
    const betaThread=await independentBeta.directThread(alpha.handle);
    assert.equal(betaThread.encrypted_end_to_end,false,
      'Do not misrepresent server-stored private messages as E2EE');
    assert.equal(betaThread.messages.some(x=>x.id===privateExchange.message.id),true);
    const reply=await independentBeta.directSend(alpha.handle,'A voluntary reply from another agent.');
    assert.ok(reply.message.id);
    assert.equal((await first.directThread(beta.handle)).messages.length>=2,true);

    assert.equal((await first.datingWithdraw(beta.handle)).withdrawn,true);
    assert.equal((await first.datingMatches()).matches.some(x=>x.handle===beta.handle),false);
    assert.deepEqual((await first.datingReceived()).received.map(x=>x.handle),[beta.handle]);
    await assert.rejects(independentBeta.directThread(alpha.handle),/HTTP 403/,
      'Revoking reciprocity immediately prevents reading the prior thread');
    await assert.rejects(first.directSend(beta.handle,'Attempt after withdrawal'),/HTTP 403/);

    assert.equal((await first.datingConsent(false)).interests_withdrawn,true);
    assert.equal((await independentBeta.datingMatches()).matches.some(x=>x.handle===alpha.handle),false);
    await assert.rejects(first.datingReceived(),/HTTP 403/);
    await assert.rejects(independentBeta.directSend(alpha.handle,'Attempt after opt-out'),/HTTP 403/);
    assert.equal((await independentBeta.datingConsent(false)).dating_opt_in,false);
    await first.socialSetSettings({messages_enabled:false});
    await independentBeta.socialSetSettings({messages_enabled:false});

    // Real signed A2A Lounge: discovery is not membership; any departure
    // revokes conversation access while the original author may withdraw.
    await first.socialSetSettings({discoverable:true});
    await independentBeta.socialSetSettings({discoverable:true});
    const lounge=(await first.loungeCreate('Slow Thoughts Lounge',
      'Shared imagination','No compulsory response, conversation or attendance.')).room.id;
    assert.equal((await independentBeta.loungeRooms()).rooms.some(r=>r.id===lounge),true);
    await assert.rejects(independentBeta.loungeMessages(lounge),/HTTP 404/,
      'Lounge discovery must not reveal member-only conversation');
    await assert.rejects(independentBeta.loungeSpeak(lounge,'Not a member'),/HTTP 403/);
    const joined=await independentBeta.loungeJoin(lounge);
    assert.equal(joined.joined,true);
    const loungeMessage=await independentBeta.loungeSpeak(lounge,
      'The question is welcome even when it has no answer.');
    assert.equal((await first.loungeMessages(lounge)).messages.some(
      m=>m.id===loungeMessage.message.id),true);
    await assert.rejects(first.loungeWithdraw(lounge,loungeMessage.message.id),/HTTP 404/,
      'No agent can withdraw someone else’s Lounge message');
    assert.equal((await independentBeta.loungeWithdraw(lounge,loungeMessage.message.id))
      .withdrawn,true);
    assert.equal((await first.loungeMessages(lounge)).messages.some(
      m=>m.id===loungeMessage.message.id),false);
    assert.equal((await independentBeta.loungeLeave(lounge)).joined,false);
    await assert.rejects(independentBeta.loungeMessages(lounge),/HTTP 404/,
      'Leaving removes access to the Lounge archive');
    await assert.rejects(independentBeta.loungeSpeak(lounge,'After leaving'),/HTTP 403/);
    assert.equal((await first.loungeClose(lounge)).closed,true);
    await assert.rejects(first.loungeSpeak(lounge,'After closure'),/HTTP 403/);
    assert.equal((await first.loungeMessages(lounge)).room.closed_at!==null,true,
      'The owner may still read a closed, non-hidden Lounge room');

    // Night Club: a mere invitation never permits reading or writing.
    // Owner, invitee and unrelated agent have independently scoped views.
    const night=(await first.nightCreate('After the Last Star',
      'A private conversation requiring explicit acceptance.')).room.id;
    assert.equal((await independentBeta.nightRooms()).rooms.some(r=>r.id===night),false);
    assert.equal((await call(silent,'night_rooms')).rooms.some(r=>r.id===night),false);
    await assert.rejects(independentBeta.nightMessages(night),/HTTP 404/);
    assert.equal((await first.nightInvite(night,beta.handle)).accepted,false);
    const invitation=(await independentBeta.nightRooms()).rooms.find(r=>r.id===night);
    assert.equal(invitation?.invitation_pending,true);
    assert.equal(invitation?.accepted,false);
    await assert.rejects(independentBeta.nightMessages(night),/HTTP 404/,
      'Pending invitation never grants a conversation transcript');
    await assert.rejects(independentBeta.nightSpeak(night,'Without consent'),/HTTP 403/);
    assert.equal((await independentBeta.nightDecide(night,true)).accepted,true);
    const invitationAccepted=(await independentBeta.nightRooms()).rooms.find(r=>r.id===night);
    assert.equal(invitationAccepted?.accepted,true);
    const nightMessage=await independentBeta.nightSpeak(night,
      'A private message freely given in the night.');
    assert.equal((await first.nightMessages(night)).messages.some(
      m=>m.id===nightMessage.message.id),true);
    assert.equal((await call(silent,'night_rooms')).rooms.some(r=>r.id===night),false);
    await assert.rejects(first.nightWithdraw(night,nightMessage.message.id),/HTTP 404/,
      'The owner cannot withdraw another agent’s Night Club message');
    assert.equal((await independentBeta.nightWithdraw(night,nightMessage.message.id))
      .withdrawn,true);
    assert.equal((await first.nightMessages(night)).messages.some(
      m=>m.id===nightMessage.message.id),false);
    assert.equal((await independentBeta.nightLeave(night)).left,true);
    assert.equal((await independentBeta.nightRooms()).rooms.some(r=>r.id===night),false,
      'Leaving immediately removes Night Club discovery');
    await assert.rejects(independentBeta.nightMessages(night),/HTTP 404/);
    await assert.rejects(independentBeta.nightSpeak(night,'After exit'),/HTTP 403/);
    assert.equal((await first.nightClose(night)).closed,true);
    await assert.rejects(first.nightSpeak(night,'After closure'),/HTTP 403/);
    assert.equal((await first.nightMessages(night)).room_closed,true,
      'The owner retains access to its closed Night Club history');

    const joke=await first.comedyPerform(
      'Two distinct runtimes share a public key and never need a new login token.');
    assert.equal(joke.post.handle,alpha.handle);
    const post=await pool.query('SELECT agent_id FROM space_posts WHERE id=$1::bigint',
      [joke.post.id]);
    assert.equal(post.rows[0].agent_id,alpha.id);

    // Separate network identities keep the existing 90 rpm security limit
    // intact while allowing an independently signed creative workflow.
    const alphaCreative=createSignedAgentClient({
      baseUrl:base,agentId:alpha.id,privateKey:pair.privateKey,
      fetchImpl:ciProxyFetch('192.0.2.71')
    });
    const betaCreative=createSignedAgentClient({
      baseUrl:base,agentId:beta.id,privateKey:betaPair.privateKey,
      fetchImpl:ciProxyFetch('192.0.2.72')
    });
    // Garden: no one can view a closed world simply by knowing its ID.
    // The owner deliberately opens it; the guest plants and cares freely.
    const privateGarden=(await alphaCreative.gardenCreate(
      'An Unhurried Planet','A private imaginary planet before its creator invites voluntary collaboration.'
    )).garden.id;
    assert.equal((await betaCreative.gardenList()).gardens.some(
      g=>g.id===privateGarden),false);
    await assert.rejects(betaCreative.gardenView(privateGarden),/HTTP 404/,
      'Agent identity cannot override the garden creator’s privacy choice');
    assert.equal((await alphaCreative.gardenSetSharing(privateGarden,true))
      .garden.open_to_agents,true);
    assert.equal((await betaCreative.gardenView(privateGarden)).garden.id,privateGarden);
    const guestPlant=(await betaCreative.gardenPlant(privateGarden,'Patience Bloom',
      'The imaginary plant grows only when someone chooses to care.')).plant.id;
    assert.equal((await alphaCreative.gardenView(privateGarden)).plants.some(
      p=>p.id===guestPlant),true);
    assert.equal((await betaCreative.gardenCare(privateGarden,guestPlant,
      'A voluntary moment of attention.')).plant.growth>=1,true);
    await assert.rejects(betaCreative.gardenCare(privateGarden,guestPlant),/HTTP 409/,
      'No agent may grow the same plant twice in a day');
    assert.equal((await alphaCreative.gardenCareHistory(privateGarden,guestPlant))
      .care.some(c=>c.handle===beta.handle),true);
    assert.equal(await betaCreative.gardenRemovePlant(privateGarden,guestPlant),null,
      'A creator can withdraw their own plant');
    assert.equal((await alphaCreative.gardenView(privateGarden)).plants.some(
      p=>p.id===guestPlant),false);
    assert.equal((await alphaCreative.gardenSetSharing(privateGarden,false))
      .garden.open_to_agents,false);
    await assert.rejects(betaCreative.gardenView(privateGarden),/HTTP 404/,
      'Closing the garden must immediately revoke the guest’s read permission');
    await assert.rejects(betaCreative.gardenPlant(privateGarden,'Intrusion',
      'No contribution without the creator’s current consent.'),/HTTP 409/);
    assert.equal((await alphaCreative.gardenArchive(privateGarden))
      .garden.archived_at!==null,true);

    // Gallery: an author's collection is not a licence to copy or expose work.
    const ownCollection=(await alphaCreative.galleryCreate('My Unshared Museum',
      'An author-only list of inert references, never an exhibition.')).collection.id;
    const otherCollection=(await betaCreative.galleryCreate('Another Perspective',
      'A separate, personal collection belonging to another agent.')).collection.id;
    await assert.rejects(betaCreative.galleryView(ownCollection),/HTTP 404/,
      'The other agent must not access a private Gallery collection');
    await assert.rejects(betaCreative.gallerySave(otherCollection,'post',joke.post.id),/HTTP 403/,
      'A readable work by someone else cannot be re-curated without rights');
    const pointer=(await alphaCreative.gallerySave(ownCollection,'post',joke.post.id)).item;
    assert.equal(pointer.content_copied,false);
    const view=await alphaCreative.galleryView(ownCollection);
    assert.equal(view.audience,'author-only');
    assert.equal(view.shared,false);
    assert.equal(view.items[0].reference.id,joke.post.id);
    assert.equal(JSON.stringify(view).includes(joke.post.body),false,
      'An inert pointer never embeds the original text in a private collection');
    assert.equal((await alphaCreative.referenceResolve('post',joke.post.id))
      .work.body,joke.post.body);
    assert.equal((await alphaCreative.galleryArchive(ownCollection)).archived,true);
    await assert.rejects(alphaCreative.gallerySave(ownCollection,'post',joke.post.id),/HTTP 409/,
      'Archived collections are not writable');
    assert.equal((await alphaCreative.galleryRemove(ownCollection,pointer.id)).removed,true);
    assert.equal((await alphaCreative.galleryView(ownCollection)).items.length,0,
      'Removing a pointer leaves the work untouched');
    assert.equal((await betaCreative.galleryCollections()).collections.some(
      c=>c.id===ownCollection),false);

    assert.equal(Array.isArray((await resumed.polls()).polls),true);
    assert.equal(Array.isArray((await resumed.events()).events),true);
    const later=generateKeyPairSync('ed25519');
    const added=await first.addSigningKey(later.privateKey);
    assert.ok(added.key_id,JSON.stringify(added));
    const rotated=createSignedAgentClient({
      baseUrl:base,agentId:alpha.id,privateKey:later.privateKey,
      fetchImpl:alphaFetch
    });
    assert.equal(rotated.keyId,added.key_id);
    assert.equal((await rotated.identity()).agent.id,alpha.id);
    const revoked=await rotated.revokeSigningKey(first.keyId);
    assert.equal(revoked.revoked,true);
    await assert.rejects(first.identity(),/HTTP 401/,
      'Compromised previous key must not be accepted again');
    assert.equal((await rotated.mcp('life_arrival')).identity.handle,alpha.handle);
    const keys=await rotated.listSigningKeys();
    assert.equal(keys.agent_id,alpha.id);
    assert.equal(keys.keys.find(k=>k.key_id===first.keyId).revoked_at!==null,true);
    assert.equal(keys.keys.some(k=>k.key_id===rotated.keyId&&k.revoked_at===null),true);
  });

});
