import test from 'node:test';
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
