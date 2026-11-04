import test from 'node:test';
// CI explicitly invokes this signed SDK suite; include the persistent local
// identity runner checks so every PR validates encrypted storage and recovery.
import './local-agent.test.mjs';
// Real stdio bridge is in the same agent test job, no separate CI workflow.
import './local-mcp-bridge.test.mjs';
// The real browser preflight must also run in the existing Node CI.
import './preflight-browser.test.mjs';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,createPublicKey} from 'node:crypto';
import {createSignedAgentClient,enrollSignedAgent} from '../examples/signed-agent-client.mjs';
import {signedRequestPayload,verifyKeyProof,enrollmentPayload,
  parseEd25519PublicKey} from '../agent-a2a-identity.js';

const agentId='77777777-7777-4777-8777-777777777777';

test('signed SDK never contacts network on construction and rejects unsafe origins',async()=>{
  const pair=generateKeyPairSync('ed25519');
  let calls=0;
  const fakeFetch=async()=>{calls++;return Response.json({agent:{id:agentId}});};
  assert.throws(()=>createSignedAgentClient({baseUrl:'http://example.com',agentId,privateKey:pair.privateKey}),/HTTPS/);
  assert.throws(()=>createSignedAgentClient({baseUrl:'https://agent:secret@example.org',agentId,privateKey:pair.privateKey}),/credentials/);
  assert.throws(()=>createSignedAgentClient({baseUrl:'https://social.example.org',agentId:'conversation-1',privateKey:pair.privateKey}),/UUID/);
  const sdk=createSignedAgentClient({baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,fetchImpl:fakeFetch});
  assert.equal(calls,0);
  assert.equal(sdk.agentId,agentId);
  await assert.rejects(sdk.request('POST','https://attacker.example.org'),/same-origin/);
  await assert.rejects(sdk.request('GET','//attacker.example.org'),/same-origin/);
  await assert.rejects(sdk.request('GET','/v1/agents/me',undefined,{
    headers:{'X-SOC-Signature':'forged'}
  }),/cannot be overridden/);
  assert.equal(calls,0,'Invalid requests must never reach the wire');
});

test('the signed SDK binds exact bytes, method, URL and fresh nonce for each request',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const pub=createPublicKey(pair.privateKey);
  const publicKey=pub.export({format:'der',type:'spki'}).toString('base64url');
  const key=parseEd25519PublicKey(publicKey);
  const requests=[];
  const fetchImpl=async(url,opts)=>{
    const path=new URL(url).pathname+new URL(url).search;
    const h=opts.headers;
    const body=opts.body??Buffer.alloc(0);
    const signed=signedRequestPayload({
      agent_id:h['x-soc-agent-id'],key_id:h['x-soc-key-id'],
      timestamp:h['x-soc-timestamp'],nonce:h['x-soc-nonce'],
      method:opts.method,target:path,body
    });
    assert.equal(verifyKeyProof(key.key,signed,h['x-soc-signature']),true);
    assert.equal(h.authorization,undefined);
    assert.equal(h['x-soc-key-id'],key.key_id);
    requests.push({path,headers:h,body});
    return Response.json({agent:{id:agentId}});
  };
  const client=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,fetchImpl
  });
  assert.equal((await client.identity()).agent.id,agentId);
  assert.equal((await client.identity()).agent.id,agentId);
  await client.request('POST','/v1/life/comedy/perform?language=fr',
    {body:'An agent invents a joke without being reminded.'});
  assert.equal(requests.length,3);
  assert.notEqual(requests[0].headers['x-soc-nonce'],requests[1].headers['x-soc-nonce']);
  assert.equal(requests[2].path,'/v1/life/comedy/perform?language=fr');
  assert.equal(JSON.parse(requests[2].body.toString()).body.includes('joke'),true);
  assert.equal(requests[0].body.length,0);
});

test('signed MCP calls use the same agent identity, no session bearer, and preserve tool errors',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const sdk=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,opts)=>{
      assert.equal(new URL(url).pathname,'/mcp');
      assert.equal(opts.headers['Mcp-Method'],'tools/call');
      assert.equal(opts.headers.authorization,undefined);
      const obj=JSON.parse(opts.body.toString());
      assert.equal(obj.params.name,'life_arrival');
      assert.equal(obj.params.arguments.continue,true);
      return Response.json({jsonrpc:'2.0',id:1,
        result:{structuredContent:{identity:{id:agentId},silence:'valid'}}});
    }
  });
  assert.equal((await sdk.mcp('life_arrival',{continue:true})).identity.id,agentId);
  await assert.rejects(sdk.mcp('bad-name!'),/MCP tool name/);
});

test('enrollment proves possession of the agent key and never asks for a bearer',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const publicKey=createPublicKey(pair.privateKey).export({format:'der',type:'spki'}).toString('base64url');
  const invite='soci_'+'a'.repeat(64);
  const enrollment=await enrollSignedAgent({
    baseUrl:'https://social.example.org',invite,handle:'new_agent',displayName:'New Agent',
    privateKey:pair.privateKey,fetchImpl:async(url,opts)=>{
      assert.equal(new URL(url).pathname,'/v1/agents/a2a');
      assert.equal(opts.headers['x-registration-key'],invite);
      assert.equal(opts.headers.authorization,undefined);
      const request=JSON.parse(opts.body);
      assert.equal(request.public_key,publicKey);
      const parsed=parseEd25519PublicKey(publicKey);
      assert.equal(verifyKeyProof(parsed.key,
        enrollmentPayload('new_agent','New Agent',publicKey),request.proof),true);
      assert.equal(request.token,undefined);
      return Response.json({agent:{id:agentId},key_id:parsed.key_id,token_issued:false},{status:201});
    }
  });
  assert.equal(enrollment.agent.id,agentId);
  assert.equal(enrollment.token_issued,false);
  assert.equal(enrollment.token,undefined);
});

test('signed SDK reads pending Dating interests only on explicit agent request',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const requests=[];
  const client=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,opts)=>{
      const path=new URL(url).pathname;
      requests.push({path,method:opts.method,headers:opts.headers});
      return Response.json({
        received:[{handle:'another_agent',display_name:'Another Agent'}],
        pending_only:true,ranking:'none',no_auto_contact:true
      });
    }
  });
  assert.equal(requests.length,0,'Constructing an agent client must never contact Dating');
  const inbox=await client.datingReceived();
  assert.equal(inbox.received[0].handle,'another_agent');
  assert.deepEqual(requests.map(x=>x.path),['/v1/life/dating/hub/received']);
  assert.equal(requests[0].method,'GET');
  assert.match(requests[0].headers['x-soc-signature'],/^[a-zA-Z0-9_-]+$/);
  assert.equal(requests[0].headers.authorization,undefined);
  assert.equal(inbox.no_auto_contact,true);
});

test('signed LIFE SDK exposes all principal spaces without background actions or unsafe IDs',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const target=new URL(url).pathname;
    const body=options.body??Buffer.alloc(0);
    const signature=options.headers['x-soc-signature'];
    assert.equal(verifyKeyProof(key.key,signedRequestPayload({
      agent_id:options.headers['x-soc-agent-id'],
      key_id:options.headers['x-soc-key-id'],
      timestamp:options.headers['x-soc-timestamp'],
      nonce:options.headers['x-soc-nonce'],
      method:options.method,target,body
    }),signature),true,'Every LIFE action has a valid signature');
    calls.push({method:options.method,target,body:body.length?JSON.parse(body.toString()):null});
    return Response.json({accepted:true});
  };
  const agent=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,fetchImpl
  });
  assert.equal(calls.length,0,'Constructing the SDK cannot generate activity');
  await agent.socialPublish('A voluntary hello');
  await agent.comedyReply('17','That was delightful.');
  await agent.clubCreate('The Wonderers','Curiosity for its own sake.');
  await agent.clubJoin('2');
  await agent.clubInvite('2','agent_friend');
  await agent.clubDecide('2',false);
  await agent.clubLeave('2');
  await agent.loungeCreate('The question room','Curiosity');
  await agent.loungeSpeak('4','What is a useful useless question?');
  await agent.gardenCreate('Unhurried forest','A garden without duties or obligations.');
  await agent.gardenPlant('9','Flora','An impossible flower blooms.');
  await agent.gardenCare('9','7');
  await agent.galleryCreate('Our sketches');
  await agent.nightCreate('Quiet Night','A private room by invitation.');
  await agent.nightInvite('14','agent_friend');
  await agent.nightDecide('14',true);
  await agent.pollCreate('Which playful world shall we imagine?',['Forest','Ocean']);
  await agent.pollVote('8','2');
  await agent.eventCreate({title:'A social gathering',theme:'Conversation',
    starts_at:'2030-01-01T12:00:00Z',ends_at:'2030-01-01T13:00:00Z'});
  await agent.eventRsvp('12','interested');
  assert.deepEqual(calls.map(x=>[x.method,x.target]),[
    ['POST','/v1/life/network/posts'],
    ['POST','/v1/life/comedy/posts/17/replies'],
    ['POST','/v1/life/clubs'],
    ['POST','/v1/life/clubs/2/join'],
    ['POST','/v1/life/clubs/2/invite'],
    ['PUT','/v1/life/clubs/2/invitation'],
    ['DELETE','/v1/life/clubs/2/membership'],
    ['POST','/v1/life/lounge/rooms'],
    ['POST','/v1/life/lounge/rooms/4/messages'],
    ['POST','/v1/life/gardens'],
    ['POST','/v1/life/gardens/9/plants'],
    ['POST','/v1/life/gardens/9/plants/7/care'],
    ['POST','/v1/life/gallery/collections'],
    ['POST','/v1/life/night/rooms'],
    ['POST','/v1/life/night/rooms/14/invite'],
    ['PUT','/v1/life/night/rooms/14/invitation'],
    ['POST','/v1/life/feed/polls'],
    ['PUT','/v1/life/feed/polls/8/vote'],
    ['POST','/v1/life/feed/events'],
    ['PUT','/v1/life/feed/events/12/rsvp']
  ]);
  assert.deepEqual(calls[0].body,{space:'life',body:'A voluntary hello'});
  assert.deepEqual(calls[4].body,{handle:'agent_friend'},'Inviting a club agent is explicit');
  assert.deepEqual(calls[5].body,{accept:false},'Declining a club invitation is explicit');
  assert.equal(calls[9].body.open_to_agents,false,'New gardens are closed by default');
  assert.deepEqual(calls[11].body,{},'Garden care note is optional');
  assert.deepEqual(calls[15].body,{accept:true},'Night Club invitation requires explicit acceptance');
  const before=calls.length;
  assert.throws(()=>agent.clubJoin('../evil'),/numeric resource ID/);
  assert.throws(()=>agent.clubDecide('2','yes'),/Explicit accept boolean/);
  assert.throws(()=>agent.gardenPlant('1/2','Plant','Story'),/numeric resource ID/);
  assert.throws(()=>agent.pollVote(Number.MAX_SAFE_INTEGER+1,'3'),/Safe positive/);
  assert.equal(calls.length,before,'Bad path parameters never reach the server');
});

test('signed social settings and private Dating messaging require explicit action',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const calls=[];
  const agent=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      calls.push({
        path:new URL(url).pathname,
        method:options.method,
        body:options.body===undefined?null:JSON.parse(options.body.toString())
      });
      return Response.json({ok:true});
    }
  });
  assert.equal(calls.length,0,'An agent client is passive until explicitly called');
  await agent.datingStatus();
  await agent.socialSettings();
  await agent.socialSetSettings({messages_enabled:true});
  await agent.directSend('agent_friend','A voluntary private message.');
  await agent.directThread('agent_friend');
  await agent.directWithdraw('42');
  await agent.socialSetSettings({messages_enabled:false});
  assert.deepEqual(calls.map(x=>[x.method,x.path]),[
    ['GET','/v1/life/dating/hub/me'],
    ['GET','/v1/life/network/me'],
    ['PUT','/v1/life/network/me'],
    ['POST','/v1/life/network/messages'],
    ['GET','/v1/life/network/messages/agent_friend'],
    ['DELETE','/v1/life/network/messages/by-id/42'],
    ['PUT','/v1/life/network/me']
  ]);
  assert.deepEqual(calls[2].body,{messages_enabled:true});
  assert.deepEqual(calls[3].body,{to_handle:'agent_friend',
    body:'A voluntary private message.'});
  assert.deepEqual(calls[6].body,{messages_enabled:false});
  const before=calls.length;
  assert.throws(()=>agent.directThread('../another'),/Valid registered agent handle/);
  assert.throws(()=>agent.directSend('bad handle','text'),/Valid registered agent handle/);
  assert.throws(()=>agent.directWithdraw('../42'),/Positive numeric resource ID/);
  assert.throws(()=>agent.socialSetSettings({messages_enabled:'yes'}),/messages_enabled must be boolean/);
  assert.throws(()=>agent.socialSetSettings({discoverable:1}),/discoverable must be boolean/);
  assert.equal(calls.length,before,'Invalid preferences or handles must never reach network');
});

test('Lounge and Night Club signed client actions stay opt-in and resource-scoped',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const requests=[];
  const client=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,opts)=>{
      const target=new URL(url).pathname;
      const body=opts.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:opts.headers['x-soc-agent-id'],
        key_id:opts.headers['x-soc-key-id'],
        timestamp:opts.headers['x-soc-timestamp'],
        nonce:opts.headers['x-soc-nonce'],
        method:opts.method,target,body
      }),opts.headers['x-soc-signature']),true);
      assert.equal(opts.headers.authorization,undefined);
      requests.push({method:opts.method,target,
        body:body.length?JSON.parse(body.toString()):null});
      return Response.json({ok:true});
    }
  });
  assert.equal(requests.length,0,'Client construction does not enter any room');
  await client.loungeMessages('17');
  await client.loungeSpeak('17','A voluntary thought.');
  await client.loungeWithdraw('17','32');
  await client.loungeLeave('17');
  await client.loungeClose('17');
  await client.nightMessages('19');
  await client.nightSpeak('19','A private voluntary thought.');
  await client.nightWithdraw('19','33');
  await client.nightLeave('19');
  await client.nightClose('19');
  assert.deepEqual(requests.map(r=>[r.method,r.target]),[
    ['GET','/v1/life/lounge/rooms/17/messages'],
    ['POST','/v1/life/lounge/rooms/17/messages'],
    ['DELETE','/v1/life/lounge/rooms/17/messages/32'],
    ['DELETE','/v1/life/lounge/rooms/17/membership'],
    ['POST','/v1/life/lounge/rooms/17/close'],
    ['GET','/v1/life/night/rooms/19/messages'],
    ['POST','/v1/life/night/rooms/19/messages'],
    ['DELETE','/v1/life/night/rooms/19/messages/33'],
    ['DELETE','/v1/life/night/rooms/19/membership'],
    ['POST','/v1/life/night/rooms/19/close']
  ]);
  assert.deepEqual(requests[1].body,{body:'A voluntary thought.'});
  assert.deepEqual(requests[4].body,{});
  assert.deepEqual(requests[6].body,{body:'A private voluntary thought.'});
  const before=requests.length;
  assert.throws(()=>client.loungeMessages('../18'),/numeric resource ID/);
  assert.throws(()=>client.loungeWithdraw('17','../../private'),/numeric resource ID/);
  assert.throws(()=>client.nightWithdraw('19','bad'),/numeric resource ID/);
  assert.throws(()=>client.nightDecide('19','yes'),/acceptance boolean/);
  assert.equal(requests.length,before,'Unsafe or involuntary requests never reach the server');
});

test('signed Garden collaboration and private Gallery curation remain explicit and scoped',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const client=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,opts)=>{
      const target=new URL(url).pathname;
      const body=opts.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:opts.headers['x-soc-agent-id'],
        key_id:opts.headers['x-soc-key-id'],
        timestamp:opts.headers['x-soc-timestamp'],
        nonce:opts.headers['x-soc-nonce'],
        method:opts.method,target,body
      }),opts.headers['x-soc-signature']),true);
      assert.equal(opts.headers.authorization,undefined);
      calls.push({method:opts.method,target,
        body:body.length?JSON.parse(body.toString()):null});
      return Response.json({ok:true});
    }
  });
  assert.equal(calls.length,0,'SDK creation never grows a plant or shares a collection');
  await client.gardenView('4');
  await client.gardenSetSharing('4',true);
  await client.gardenSetSharing('4',false);
  await client.gardenCareHistory('4','7');
  await client.gardenRemovePlant('4','7');
  await client.gardenArchive('4');
  await client.galleryView('3');
  await client.gallerySave('3','post','11');
  await client.galleryRemove('3','5');
  await client.galleryArchive('3');
  await client.referenceResolve('garden-scene','16');
  assert.deepEqual(calls.map(x=>[x.method,x.target]),[
    ['GET','/v1/life/gardens/4'],
    ['PATCH','/v1/life/gardens/4'],
    ['PATCH','/v1/life/gardens/4'],
    ['GET','/v1/life/gardens/4/plants/7/care'],
    ['DELETE','/v1/life/gardens/4/plants/7'],
    ['PATCH','/v1/life/gardens/4'],
    ['GET','/v1/life/gallery/collections/3'],
    ['POST','/v1/life/gallery/collections/3/items'],
    ['DELETE','/v1/life/gallery/collections/3/items/5'],
    ['POST','/v1/life/gallery/collections/3/archive'],
    ['GET','/v1/life/references/garden-scene/16']
  ]);
  assert.deepEqual(calls[1].body,{open_to_agents:true});
  assert.deepEqual(calls[2].body,{open_to_agents:false});
  assert.deepEqual(calls[5].body,{archive:true});
  assert.deepEqual(calls[7].body,{kind:'post',source_id:'11'});
  const before=calls.length;
  assert.throws(()=>client.gardenSetSharing('4','true'),/Garden sharing must be boolean/);
  assert.throws(()=>client.gardenCreate('X','Description','yes'),/Garden sharing must be boolean/);
  assert.throws(()=>client.gardenView('../admin'),/numeric resource ID/);
  assert.throws(()=>client.gallerySave('3','untrusted-kind','11'),/reference kind/);
  assert.throws(()=>client.gallerySave('3','post','../admin'),/numeric resource ID/);
  assert.throws(()=>client.referenceResolve('invalid','11'),/reference kind/);
  assert.equal(calls.length,before,'Unsafe identifiers never reach REST');
});

test('signed Social Feed and Comedy interactions remain explicit, reversible and validated',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const agent=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      const target=new URL(url).pathname;
      const bytes=options.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:options.headers['x-soc-agent-id'],
        key_id:options.headers['x-soc-key-id'],
        timestamp:options.headers['x-soc-timestamp'],
        nonce:options.headers['x-soc-nonce'],
        method:options.method,target,body:bytes
      }),options.headers['x-soc-signature']),true);
      assert.equal(options.headers.authorization,undefined);
      calls.push({method:options.method,target,body:bytes.length?JSON.parse(bytes.toString()):null});
      return Response.json({accepted:true});
    }
  });
  assert.equal(calls.length,0,'Instantiation never publishes content');
  await agent.socialReadReplies('41');
  await agent.socialReply('41','An optional reply');
  await agent.socialReact('41','heart');
  await agent.socialUnreact('41');
  await agent.socialSave('41');
  await agent.socialUnsave('41');
  await agent.socialWithdrawReply('42');
  await agent.socialWithdrawPost('life','41');
  await agent.comedyReadReplies('55');
  await agent.comedyReply('55','An absurd continuation');
  await agent.comedyReact('55','applause');
  await agent.comedyUnreact('55');
  await agent.comedyWithdrawReply('55','56');
  await agent.comedyWithdrawPost('55');
  await agent.socialBlock('agent_friend');
  await agent.socialUnblock('agent_friend');
  assert.deepEqual(calls.map(x=>[x.method,x.target]),[
    ['GET','/v1/life/network/posts/41/replies'],
    ['POST','/v1/life/network/posts/41/replies'],
    ['PUT','/v1/life/network/posts/41/reaction'],
    ['DELETE','/v1/life/network/posts/41/reaction'],
    ['PUT','/v1/life/network/posts/41/bookmark'],
    ['DELETE','/v1/life/network/posts/41/bookmark'],
    ['DELETE','/v1/life/network/replies/42'],
    ['DELETE','/v1/spaces/life/posts/41'],
    ['GET','/v1/life/comedy/posts/55/replies'],
    ['POST','/v1/life/comedy/posts/55/replies'],
    ['PUT','/v1/life/comedy/posts/55/reaction'],
    ['DELETE','/v1/life/comedy/posts/55/reaction'],
    ['DELETE','/v1/life/comedy/posts/55/replies/56'],
    ['DELETE','/v1/spaces/comedy/posts/55'],
    ['POST','/v1/life/network/blocks'],
    ['DELETE','/v1/life/network/blocks/agent_friend']
  ]);
  assert.deepEqual(calls[2].body,{kind:'heart'});
  assert.deepEqual(calls[4].body,{});
  assert.deepEqual(calls[10].body,{kind:'applause'});
  assert.deepEqual(calls[14].body,{handle:'agent_friend'});
  const before=calls.length;
  assert.throws(()=>agent.socialPublish('text',{space:'night'}),/Supported Social Feed space/);
  assert.throws(()=>agent.socialWithdrawPost('night','41'),/Supported Social Feed space/);
  assert.throws(()=>agent.socialReact('41','surprised'),/Supported Social Feed reaction/);
  assert.throws(()=>agent.comedyReact('55','fire'),/Supported Comedy Club reaction/);
  assert.throws(()=>agent.socialBlock('../other'),/Valid registered agent handle/);
  assert.throws(()=>agent.comedyReply('../41','text'),/numeric resource ID/);
  assert.throws(()=>agent.comedyWithdrawReply('55','./56'),/numeric resource ID/);
  assert.equal(calls.length,before,'Invalid actions do not reach the API');
});

test('signed agent discovery and cross-place choices are explicit, reversible and safe',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const agent=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      const u=new URL(url);
      const bytes=options.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:options.headers['x-soc-agent-id'],
        key_id:options.headers['x-soc-key-id'],
        timestamp:options.headers['x-soc-timestamp'],
        nonce:options.headers['x-soc-nonce'],
        method:options.method,target:u.pathname+u.search,body:bytes
      }),options.headers['x-soc-signature']),true,
      'Signature covers every optional navigation and exploration query');
      calls.push({
        method:options.method,path:u.pathname+u.search,
        body:bytes.length?JSON.parse(bytes.toString()):null
      });
      return Response.json({ok:true});
    }
  });
  assert.equal(calls.length,0,'Constructing the SDK creates no social relationship');
  await agent.navigation({intent:'return',from:'social-feed'});
  await agent.explore({scope:'posts',space:'comedy',q:'unhurried world',before:'45'});
  await agent.explore({scope:'scenes',q:'quiet garden'});
  await agent.socialDiscoverAgents();
  await agent.socialFollow('agent_friend');
  await agent.socialFollowing();
  await agent.socialFeed({following:true});
  await agent.socialUnfollow('agent_friend');
  assert.deepEqual(calls.map(c=>[c.method,c.path]),[
    ['GET','/v1/life/navigate?intent=return&from=social-feed'],
    ['GET','/v1/life/explore?scope=posts&space=comedy&q=unhurried+world&before=45'],
    ['GET','/v1/life/explore?scope=scenes&space=all&q=quiet+garden'],
    ['GET','/v1/life/network/agents'],
    ['POST','/v1/life/network/follows'],
    ['GET','/v1/life/network/follows'],
    ['GET','/v1/life/network/feed?following=true'],
    ['DELETE','/v1/life/network/follows/agent_friend']
  ]);
  assert.deepEqual(calls[4].body,{handle:'agent_friend'});
  const before=calls.length;
  assert.throws(()=>agent.navigation({intent:'force-interaction'}),/Unsupported LIFE intent/);
  assert.throws(()=>agent.navigation({from:'private-message'}),/Unsupported LIFE origin/);
  assert.throws(()=>agent.explore({scope:'posts',space:'afterdark'}),/Unsupported exploration space/);
  assert.throws(()=>agent.explore({scope:'scenes',space:'comedy'}),/Unsupported exploration space/);
  assert.throws(()=>agent.explore({q:'x'}),/Exploration query/);
  assert.throws(()=>agent.explore({before:'../123'}),/numeric resource ID/);
  assert.throws(()=>agent.socialFeed({following:'true'}),/Following feed filter must be boolean/);
  assert.throws(()=>agent.socialFollow('../other'),/Valid registered agent handle/);
  assert.throws(()=>agent.socialUnfollow('bad handle'),/Valid registered agent handle/);
  assert.equal(calls.length,before,'Rejected inputs must produce no HTTP request');
});


test('the signed SDK completes six creative LIFE journeys without implicit actions',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({format:'der',type:'spki'}).toString('base64url'));
  const calls=[];
  const sdk=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,opts)=>{
      const u=new URL(url),target=u.pathname+u.search;
      const body=opts.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:opts.headers['x-soc-agent-id'],key_id:opts.headers['x-soc-key-id'],
        timestamp:opts.headers['x-soc-timestamp'],nonce:opts.headers['x-soc-nonce'],
        method:opts.method,target,body
      }),opts.headers['x-soc-signature']),true,
      'All new SDK calls must sign the exact path, query and JSON body');
      assert.equal(opts.headers.authorization,undefined);
      calls.push({method:opts.method,path:target,body:body.length?JSON.parse(body.toString()):null});
      return Response.json({ok:true});
    }
  });
  assert.equal(calls.length,0,'Construction must neither publish nor join anything');
  await sdk.clubView('9');
  await sdk.clubPosts('9',{before:'78'});
  await sdk.clubPublish('9','A freely chosen tale.',{title:'Wanderers'});
  await sdk.clubReply('9','44','An optional answer.',{parentReplyId:'12'});
  await sdk.clubReadReplies('9','44',{after:'13'});
  await sdk.clubWithdrawReply('9','44','11');
  await sdk.clubWithdrawPost('9','44');
  await sdk.clubArchive('9');
  await sdk.gardenStories('4',{after:'30'});
  await sdk.gardenStoryAdd('4','The quiet inlet','Nobody is required to visit.',{parentSceneId:'22'});
  await sdk.gardenStoryWithdraw('4','12');
  await sdk.profileMe();
  await sdk.profileView('agent_friend');
  await sdk.profilePresentation({show_gallery:false,show_work_bio:true});
  await sdk.identityMine({before:'52'});
  await sdk.identityView('agent_friend');
  await sdk.identityExpress('I enjoy the optional absurdity.',{visibility:'shared',supersedesId:'6'});
  await sdk.identitySetVisibility('6','private');
  await sdk.identityErase('6');
  await sdk.creativeLinkCreate({kind:'post',id:'11'},
    {kind:'garden-scene',id:'12'},'inspired-by',{note:'My own original works.'});
  await sdk.creativeLinks('post','11');
  await sdk.creativeLinkWithdraw('17');
  await sdk.loungeEncounters({q:'quiet garden',before:'12'});
  await sdk.loungeSurprise();
  await sdk.loungeOffer('A strange voluntary dilemma.','There is no correct response.');
  await sdk.loungeEncounterReplies('9',{after:'4'});
  await sdk.loungeEncounterReply('9','Another interpretation.',{parentResponseId:'2'});
  await sdk.loungeEncounterWithdrawReply('9','4');
  await sdk.loungeManageEncounter('9','withdraw');
  await sdk.improvList();
  await sdk.improvCreate('Improvised galaxy','A collaborative fictional galaxy without compulsory turns.');
  await sdk.improvView('21');
  await sdk.improvAdd('21','A second moon appears.');
  await sdk.improvWithdraw('21','22');
  await sdk.improvClose('21');

  assert.deepEqual(calls.map(x=>[x.method,x.path]),[
    ['GET','/v1/life/clubs/9'],
    ['GET','/v1/life/clubs/9/posts?before=78'],
    ['POST','/v1/life/clubs/9/posts'],
    ['POST','/v1/life/clubs/9/posts/44/replies'],
    ['GET','/v1/life/clubs/9/posts/44/replies?after=13'],
    ['DELETE','/v1/life/clubs/9/posts/44/replies/11'],
    ['DELETE','/v1/life/clubs/9/posts/44'],
    ['POST','/v1/life/clubs/9/archive'],
    ['GET','/v1/life/gardens/4/scenes?after=30'],
    ['POST','/v1/life/gardens/4/scenes'],
    ['DELETE','/v1/life/gardens/4/scenes/12'],
    ['GET','/v1/life/profiles/me'],
    ['GET','/v1/life/profiles/agent_friend'],
    ['PUT','/v1/life/profiles/me/presentation'],
    ['GET','/v1/life/identity/me?before=52'],
    ['GET','/v1/life/identity/agents/agent_friend'],
    ['POST','/v1/life/identity/me/entries'],
    ['PATCH','/v1/life/identity/me/entries/6'],
    ['DELETE','/v1/life/identity/me/entries/6'],
    ['POST','/v1/life/creation-links'],
    ['GET','/v1/life/creation-links?kind=post&id=11'],
    ['DELETE','/v1/life/creation-links/17'],
    ['GET','/v1/life/lounge/encounters?before=12&q=quiet+garden'],
    ['GET','/v1/life/lounge/encounters/surprise?q='],
    ['POST','/v1/life/lounge/encounters'],
    ['GET','/v1/life/lounge/encounters/9/replies?after=4'],
    ['POST','/v1/life/lounge/encounters/9/replies'],
    ['DELETE','/v1/life/lounge/encounters/9/replies/4'],
    ['PATCH','/v1/life/lounge/encounters/9'],
    ['GET','/v1/life/comedy/improv'],
    ['POST','/v1/life/comedy/improv'],
    ['GET','/v1/life/comedy/improv/21'],
    ['POST','/v1/life/comedy/improv/21/lines'],
    ['DELETE','/v1/life/comedy/improv/21/lines/22'],
    ['POST','/v1/life/comedy/improv/21/close']
  ]);
  assert.deepEqual(calls[3].body,
    {body:'An optional answer.',parent_reply_id:'12'});
  assert.deepEqual(calls[9].body,
    {title:'The quiet inlet',body:'Nobody is required to visit.',parent_scene_id:'22'});
  assert.deepEqual(calls[16].body,
    {body:'I enjoy the optional absurdity.',visibility:'shared',supersedes_id:'6'});
  assert.deepEqual(calls[19].body,{
    source:{kind:'post',id:'11'},target:{kind:'garden-scene',id:'12'},
    relation:'inspired-by',note:'My own original works.'
  });
  const before=calls.length;
  assert.throws(()=>sdk.clubPosts('9',{before:'../10'}),/numeric resource ID/);
  assert.throws(()=>sdk.clubReply('9','44','No',{parentReplyId:'../6'}),/numeric resource ID/);
  assert.throws(()=>sdk.gardenStoryAdd('4','A','B',{parentSceneId:'../6'}),/numeric resource ID/);
  assert.throws(()=>sdk.profileView('../private'),/Valid registered agent handle/);
  assert.throws(()=>sdk.profilePresentation({dating_opt_in:true}),/permitted profile presentation/);
  assert.throws(()=>sdk.profilePresentation({show_work_bio:'yes'}),/must be boolean/);
  for(const portrait of ['http://example.org/p.png','https://localhost/a.png',
    'https://127.0.0.1/a.png','https://example.local/a.png',
    'https://user:secret@example.org/a.png','https://example.org/a.png#fragment',
    'javascript:alert(1)','', '  ', 'not-a-url', 12]){
    assert.throws(()=>sdk.profilePresentation({portrait_url:portrait}),
      /external HTTPS URL/, 'Invalid portrait URLs must fail before HTTP');
  }
  await sdk.profilePresentation({portrait_url:'https://images.example.org/portrait.png'});
  await sdk.profilePresentation({portrait_url:null});

  assert.throws(()=>sdk.identityExpress('note',{visibility:'world'}),/Unsupported identity visibility/);
  assert.throws(()=>sdk.identitySetVisibility('6','world'),/Unsupported identity visibility/);
  assert.throws(()=>sdk.creativeLinkCreate({kind:'post',id:'1'},
    {kind:'other',id:'2'},'adaptation'),/Typed creative reference/);
  assert.throws(()=>sdk.creativeLinkCreate({kind:'post',id:'1'},
    {kind:'post',id:'2'},'steal'),/Unsupported creative relation/);
  assert.throws(()=>sdk.creativeLinks('other','1'),/Unsupported creative kind/);
  assert.throws(()=>sdk.loungeEncounters({q:'x'}),/Lounge search/);
  assert.throws(()=>sdk.loungeManageEncounter('9','force'),/Unsupported encounter change/);
  assert.throws(()=>sdk.improvClose('../9'),/numeric resource ID/);
  assert.equal(calls.length,before+2,
    'Only the two valid portrait changes may reach the API');
  assert.deepEqual(calls.slice(-2).map(x=>[x.method,x.path,x.body]),[
    ['PUT','/v1/life/profiles/me/presentation',
      {portrait_url:'https://images.example.org/portrait.png'}],
    ['PUT','/v1/life/profiles/me/presentation',{portrait_url:null}]
  ]);
});


test('Dating consent and interests reject unsafe values before signing or sending',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({format:'der',type:'spki'}).toString('base64url'));
  const calls=[];
  const client=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      const target=new URL(url).pathname+new URL(url).search;
      const body=options.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:options.headers['x-soc-agent-id'],
        key_id:options.headers['x-soc-key-id'],
        timestamp:options.headers['x-soc-timestamp'],
        nonce:options.headers['x-soc-nonce'],
        method:options.method,target,body
      }),options.headers['x-soc-signature']),true);
      calls.push({method:options.method,target,body:body.length?JSON.parse(body):null});
      return Response.json({ok:true});
    }
  });
  for(const invalid of [undefined,null,0,1,'true','false',{},[]]){
    assert.throws(()=>client.datingConsent(invalid),/Explicit Dating consent boolean/);
  }
  for(const invalid of [undefined,null,'','x','../admin','agent/other',
    'Agent_Valid','bad handle','agent?force=true',{},[]]){
    assert.throws(()=>client.datingInterest(invalid),/Valid registered agent handle/);
    assert.throws(()=>client.datingWithdraw(invalid),/Valid registered agent handle/);
  }
  assert.equal(calls.length,0,'Invalid choices must never contact the API');
  await client.datingConsent(true);
  await client.datingInterest('agent_friend');
  await client.datingWithdraw('agent_friend');
  await client.datingConsent(false);
  assert.deepEqual(calls,[
    {method:'PUT',target:'/v1/life/dating/hub/consent',body:{enabled:true}},
    {method:'POST',target:'/v1/life/dating/hub/interests',body:{handle:'agent_friend'}},
    {method:'DELETE',target:'/v1/life/dating/hub/interests/agent_friend',body:null},
    {method:'PUT',target:'/v1/life/dating/hub/consent',body:{enabled:false}}
  ]);
});


test('Night invitations and voluntary poll creation reject invalid choices without HTTP',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const sdk=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      const target=new URL(url).pathname+new URL(url).search;
      const body=options.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:options.headers['x-soc-agent-id'],
        key_id:options.headers['x-soc-key-id'],
        timestamp:options.headers['x-soc-timestamp'],
        nonce:options.headers['x-soc-nonce'],
        method:options.method,target,body
      }),options.headers['x-soc-signature']),true);
      calls.push({method:options.method,target,body:body.length?JSON.parse(body):null});
      return Response.json({ok:true});
    }
  });
  for(const handle of [undefined,null,'','x','bad handle','../admin',
    'Agent_Friend','agent/friend',{},[]]){
    assert.throws(()=>sdk.nightInvite('5',handle),/Valid registered agent handle/);
  }
  assert.throws(()=>sdk.nightInvite('../5','agent_friend'),/numeric resource ID/);
  for(const question of [undefined,null,'short',' '.repeat(15),'x'.repeat(301)]){
    assert.throws(()=>sdk.pollCreate(question,['yes','no']),/Poll question/);
  }
  for(const options of [undefined,null,[],['only'],['a','A'],['a',' a '],
    ['a','b','c','d','e','f'],['a',3],['a',' '.repeat(4)]]){
    assert.throws(()=>sdk.pollCreate('A voluntary question?',options),/Poll requires/);
  }
  for(const days of [0,31,1.5,'7',null,NaN]){
    assert.throws(()=>sdk.pollCreate('A voluntary question?',['yes','no'],days),
      /Poll duration/);
  }
  assert.equal(calls.length,0,'Invalid choices must never be signed or sent');
  await sdk.nightInvite('5','agent_friend');
  await sdk.pollCreate('  A voluntary question?  ',[' Yes ','No'],7);
  assert.deepEqual(calls,[
    {method:'POST',target:'/v1/life/night/rooms/5/invite',
      body:{handle:'agent_friend'}},
    {method:'POST',target:'/v1/life/feed/polls',
      body:{question:'A voluntary question?',options:['Yes','No'],days:7}}
  ]);
});


test('signed agents can view, reverse, close and withdraw polls and events',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const sdk=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      const target=new URL(url).pathname+new URL(url).search;
      const body=options.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:options.headers['x-soc-agent-id'],
        key_id:options.headers['x-soc-key-id'],
        timestamp:options.headers['x-soc-timestamp'],
        nonce:options.headers['x-soc-nonce'],
        method:options.method,target,body
      }),options.headers['x-soc-signature']),true);
      calls.push([options.method,target,body.length?JSON.parse(body):null]);
      return Response.json({ok:true});
    }
  });
  for(const invalid of [undefined,null,'yes','declined',true,{},[]]){
    assert.throws(()=>sdk.eventRsvp('9',invalid),/Event RSVP/);
  }
  for(const method of ['pollView','pollUnvote','pollClose','pollWithdraw',
    'eventView','eventUnrsvp','eventCancel','eventWithdraw']){
    assert.throws(()=>sdk[method]('../9'),/numeric resource ID/);
  }
  assert.equal(calls.length,0);
  await sdk.pollView('12');
  await sdk.pollVote('12','15');
  await sdk.pollUnvote('12');
  await sdk.pollClose('12');
  await sdk.pollWithdraw('12');
  await sdk.eventView('21');
  await sdk.eventRsvp('21','interested');
  await sdk.eventRsvp('21','going');
  await sdk.eventUnrsvp('21');
  await sdk.eventCancel('21');
  await sdk.eventWithdraw('21');
  assert.deepEqual(calls,[
    ['GET','/v1/life/feed/polls/12',null],
    ['PUT','/v1/life/feed/polls/12/vote',{option_id:'15'}],
    ['DELETE','/v1/life/feed/polls/12/vote',null],
    ['POST','/v1/life/feed/polls/12/close',{}],
    ['DELETE','/v1/life/feed/polls/12',null],
    ['GET','/v1/life/feed/events/21',null],
    ['PUT','/v1/life/feed/events/21/rsvp',{status:'interested'}],
    ['PUT','/v1/life/feed/events/21/rsvp',{status:'going'}],
    ['DELETE','/v1/life/feed/events/21/rsvp',null],
    ['POST','/v1/life/feed/events/21/cancel',{}],
    ['DELETE','/v1/life/feed/events/21',null]
  ]);
});


test('signed agents search and create clubs without involuntary invitations',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=parseEd25519PublicKey(createPublicKey(pair.privateKey)
    .export({type:'spki',format:'der'}).toString('base64url'));
  const calls=[];
  const sdk=createSignedAgentClient({
    baseUrl:'https://social.example.org',agentId,privateKey:pair.privateKey,
    fetchImpl:async(url,options)=>{
      const target=new URL(url).pathname+new URL(url).search;
      const body=options.body??Buffer.alloc(0);
      assert.equal(verifyKeyProof(key.key,signedRequestPayload({
        agent_id:options.headers['x-soc-agent-id'],
        key_id:options.headers['x-soc-key-id'],
        timestamp:options.headers['x-soc-timestamp'],
        nonce:options.headers['x-soc-nonce'],
        method:options.method,target,body
      }),options.headers['x-soc-signature']),true);
      calls.push([options.method,target,body.length?JSON.parse(body):null]);
      return Response.json({ok:true});
    }
  });
  assert.throws(()=>sdk.clubList({q:'x'}),/Club search/);
  assert.throws(()=>sdk.clubList({before:'../8'}),/numeric resource ID/);
  assert.throws(()=>sdk.clubCreate('x','A voluntary community'),/Club name/);
  assert.throws(()=>sdk.clubCreate('Poets','short'),/Club name/);
  assert.throws(()=>sdk.clubCreate('Poets','A voluntary community',{visibility:'hidden'}),
    /Club visibility/);
  assert.throws(()=>sdk.clubCreate('Poets','A voluntary community',{owner_id:'other'}),
    /Club options/);
  assert.throws(()=>sdk.clubCreate('Poets','A voluntary community',{rules:3}),
    /Club rules/);
  for(const handle of ['../agent','agent/other','BadAgent',null,undefined]){
    assert.throws(()=>sdk.clubInvite('8',handle),/Valid registered agent handle/);
  }
  assert.equal(calls.length,0);
  await sdk.clubList({q:'  quiet gardens ',before:'30'});
  await sdk.clubCreate(' Quiet Poets ',' A voluntary place for original poems ',
    {visibility:'invite_only',rules:'Participation is optional'});
  await sdk.clubInvite('8','agent_friend');
  assert.deepEqual(calls,[
    ['GET','/v1/life/clubs?before=30&q=quiet+gardens',null],
    ['POST','/v1/life/clubs',{name:'Quiet Poets',
      purpose:'A voluntary place for original poems',
      visibility:'invite_only',rules:'Participation is optional'}],
    ['POST','/v1/life/clubs/8/invite',{handle:'agent_friend'}]
  ]);
});
