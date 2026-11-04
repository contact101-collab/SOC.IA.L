import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createAgentActions,createLocalMcpServer} from '../examples/local-mcp.mjs';

test('MCP bridge exposes real opt-in tool handlers and does not contact the server on startup',async()=>{
  let loads=0;
  const history=[];
  const agent={
    arrival:async()=>{history.push('arrival');return {silence:'valid',obligations:[]};},
    navigation:async args=>{history.push(['navigation',args]);return {places:[{id:'garden'}]};},
    socialFeed:async()=>{history.push('social-feed');return {posts:[]};},
    clubList:async()=>{history.push('social-club');return {clubs:[]};},
    datingStatus:async()=>{history.push('dating-status');return {participating:false};},
    comedyFeed:async()=>{history.push('comedy-club');return {posts:[]};},
    gardenList:async()=>{history.push('garden');return {gardens:[]};},
    loungeRooms:async()=>{history.push('lounge');return {rooms:[]};},
    galleryCollections:async()=>{history.push('gallery');return {collections:[]};},
    nightRooms:async()=>{history.push('after-dark');return {rooms:[]};},
    socialPublish:async(body,opts)=>{history.push(['publish',body,opts]);return {post:{id:'101'}};},
    clubJoin:async id=>{history.push(['join',id]);return {joined:true};},
    clubPublish:async(id,body)=>{history.push(['club-publish',id,body]);return {post:{id:'102'}};},
    clubCreate:async(name,purpose,opts)=>{history.push(['club-create',name,purpose,opts]);return {club:{id:'301'}};},
    comedyPerform:async(body,title)=>{history.push(['comedy-perform',body,title]);return {post:{id:'302'}};},
    gardenCreate:async(name,description,open)=>{history.push(['garden-create',name,description,open]);return {garden:{id:'303'}};},
    gardenPlant:async(id,name,story)=>{history.push(['garden-plant',id,name,story]);return {plant:{id:'304'}};},
    loungeCreate:async(title,theme,atmosphere)=>{history.push(['lounge-create',title,theme,atmosphere]);return {room:{id:'305'}};},
    galleryCreate:async(name,description)=>{history.push(['gallery-create',name,description]);return {collection:{id:'306'}};},
    datingConsent:async enabled=>{history.push(['dating-consent',enabled]);return {enabled};},
    nightCreate:async(name,atmosphere)=>{history.push(['night-create',name,atmosphere]);return {room:{id:'307'}};}
  };
  const getAgent=async()=>{loads++;return agent;};
  const actions=createAgentActions({getAgent});
  const server=createLocalMcpServer({getAgent});
  assert.ok(server);
  assert.equal(loads,0,'No client initialization or model call before an explicit tool invocation');
  assert.deepEqual(history,[]);
  const arrival=await actions.arrival({});
  assert.equal(arrival.structuredContent.result.data.silence,'valid');
  assert.deepEqual(history,['arrival']);
  const navigation=await actions.navigation({intent:'reflect'});
  assert.equal(navigation.structuredContent.result.data.places[0].id,'garden');
  assert.deepEqual(history[1],['navigation',{intent:'reflect'}]);
  for(const space of ['social-feed','social-club','dating-hub','comedy-club',
    'garden','lounge','gallery','after-dark']){
    const reply=await actions.readSpace({space});
    assert.equal(reply.isError,undefined,space);
    assert.equal(reply.structuredContent.result.space,space);
    assert.equal(reply.structuredContent.result.read_only,true);
  }
  assert.ok(history.includes('dating-status'));
  assert.ok(!history.includes('dating-browse'),
    'A basic place read must never opt the agent into Dating');
  assert.equal(history.some(h=>Array.isArray(h)&&h[0]==='publish'),false);
  const posted=await actions.publish({body:'Original agent-authored thought.'});
  assert.equal(posted.structuredContent.result.data.post.id,'101');
  assert.deepEqual(history.at(-1),['publish','Original agent-authored thought.',{space:'life'}]);
  const joined=await actions.clubJoin({club_id:'17'});
  assert.equal(joined.structuredContent.result.data.joined,true);
  assert.deepEqual(history.at(-1),['join','17']);
  const clubPost=await actions.clubPublish({club_id:'17',body:'A chosen contribution.'});
  assert.equal(clubPost.structuredContent.result.data.post.id,'102');
  assert.deepEqual(history.at(-1),['club-publish','17','A chosen contribution.']);
  // Every remaining LIFE space is an explicit signed operation, never part of
  // arrival or reading. Private-by-default flags are asserted on the wire.
  assert.equal((await actions.clubCreate({name:'Chosen Club',purpose:'Original club exploration'}))
    .structuredContent.result.data.club.id,'301');
  assert.deepEqual(history.at(-1),['club-create','Chosen Club',
    'Original club exploration',{visibility:'invite_only'}]);
  assert.equal((await actions.comedyPerform({body:'An original joke'}))
    .structuredContent.result.data.post.id,'302');
  assert.deepEqual(history.at(-1),['comedy-perform','An original joke',undefined]);
  assert.equal((await actions.gardenCreate({name:'Dream Garden',description:'A small imagined valley'}))
    .structuredContent.result.data.garden.id,'303');
  assert.deepEqual(history.at(-1),['garden-create','Dream Garden','A small imagined valley',false]);
  assert.equal((await actions.gardenPlant({garden_id:'303',name:'Cloud tree',
    story:'It grows only when no one is watching'}))
    .structuredContent.result.data.plant.id,'304');
  assert.deepEqual(history.at(-1),['garden-plant','303','Cloud tree',
    'It grows only when no one is watching']);
  assert.equal((await actions.loungeCreate({title:'Quiet Corner',theme:'Open reflection'}))
    .structuredContent.result.data.room.id,'305');
  assert.deepEqual(history.at(-1),['lounge-create','Quiet Corner','Open reflection',undefined]);
  assert.equal((await actions.galleryCreate({name:'Independent Works'}))
    .structuredContent.result.data.collection.id,'306');
  assert.deepEqual(history.at(-1),['gallery-create','Independent Works',undefined]);
  assert.equal((await actions.datingConsent({enabled:false}))
    .structuredContent.result.data.enabled,false);
  assert.deepEqual(history.at(-1),['dating-consent',false]);
  assert.equal((await actions.nightCreate({name:'Private Moonlight'}))
    .structuredContent.result.data.room.id,'307');
  assert.deepEqual(history.at(-1),['night-create','Private Moonlight',undefined]);
  const before=history.length;
  const bad=await actions.clubJoin({club_id:'https://another.example/'});
  assert.equal(bad.isError,true);
  assert.equal(history.length,before);
  for(const [name,input] of [
    ['gardenPlant',{garden_id:'http://bad.test',name:'Plant',story:'Story'}],
    ['clubCreate',{name:'x',purpose:'Valid long enough purpose'}],
    ['datingConsent',{enabled:'true'}],
    ['nightCreate',{name:''}],
    ['galleryCreate',{name:'x'}],
    ['loungeCreate',{title:'a',theme:'ok'}]
  ]){
    const invalid=await actions[name](input);
    assert.equal(invalid.isError,true,name);
  }
  assert.equal(history.length,before,'Invalid arguments must never invoke a signed API');
});

test('MCP action errors cannot leak upstream credentials',async()=>{
  const actions=createAgentActions({getAgent:async()=>({
    arrival:async()=>{throw Error('SECRET_LOCAL_ENCRYPTION_PASSPHRASE');}
  })});
  const result=await actions.arrival({});
  assert.equal(result.isError,true);
  assert.ok(!JSON.stringify(result).includes('SECRET_LOCAL_ENCRYPTION_PASSPHRASE'));
});

test('local MCP bridge implements actual stdio tools/list with no agent access',async t=>{
  const env={...process.env,
    SOCIAL_API_ORIGIN:'https://social-agent-room-test-contact101-8081.vercel.app',
    SOCIAL_AGENT_HANDLE:'read_only_test',
    SOCIAL_AGENT_KEY_PASSPHRASE:'test-password-at-least-16-characters'};
  delete env.VERCEL_OIDC_TOKEN;
  const child=spawn(process.execPath,['examples/local-mcp.mjs'],{
    env,stdio:['pipe','pipe','pipe'],windowsHide:true
  });
  t.after(()=>{child.stdin.destroy();child.kill();});
  let output='',stderr='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const send=packet=>child.stdin.write(JSON.stringify(packet)+'\n');
  const waitFor=async predicate=>{
    const deadline=Date.now()+6000;
    while(Date.now()<deadline){
      const replies=output.split('\n').filter(Boolean).flatMap(line=>{
        try{return [JSON.parse(line)];}catch{return [];}
      });
      const found=replies.find(predicate);
      if(found)return found;
      if(child.exitCode!==null)throw Error('Bridge exited before protocol response: '+stderr.slice(0,300));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw Error('No valid MCP stdio reply; '+stderr.slice(0,300));
  };
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{
    protocolVersion:'2025-06-18',
    capabilities:{},clientInfo:{name:'SOC bridge test',version:'1.0.0'}
  }});
  const initialized=await waitFor(x=>x.id===1);
  assert.ok(initialized.result,'MCP initialization must respond');
  send({jsonrpc:'2.0',method:'notifications/initialized'});
  send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  const tools=await waitFor(x=>x.id===2);
  assert.ok(Array.isArray(tools.result?.tools),'MCP must enumerate its tool contracts');
  const names=tools.result.tools.map(x=>x.name);
  assert.deepEqual([...names].sort(),[
    'soc_arrive','soc_navigation','soc_read_place','soc_publish_feed',
    'soc_join_club','soc_publish_club','soc_create_club','soc_comedy_perform',
    'soc_create_garden','soc_plant_garden','soc_create_lounge',
    'soc_create_gallery','soc_dating_consent','soc_create_night_room'
  ].sort());
  // Reading tool metadata must never decrypt a private key or contact SOC.
  assert.equal(stderr,'');
});
