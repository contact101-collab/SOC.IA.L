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
