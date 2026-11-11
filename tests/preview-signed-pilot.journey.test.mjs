import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash,createPublicKey,verify} from 'node:crypto';
import {runPreviewSignedPilot} from '../scripts/preview-signed-pilot.mjs';
import {signedRequestPayload,rotationPayload,recoveryPayload} from '../agent-a2a-identity.js';

const site='https://social-agent-room-test-contact101-8081.vercel.app/';
const sha='a'.repeat(40),adminKey='preview-only-admin-test-secret';
const asJSON=(data,status=200)=>Response.json(data,{status});

function isolatedFakeServer({failAfterOldKeyRevocation=false,malformedRegistration=false,
  loseEnrollmentResponse=false}={}){
  const accounts=new Map(),invitations=new Set(),nonces=new Set();
  const calls=[],gardens=new Map();
  let invitationIndex=0,oldKeyErrorInjected=false;
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const live=()=>[...accounts.values()].filter(a=>!a.revoked);
  const assertPreview=({url,options})=>{
    assert.equal(new URL(url).origin,site.slice(0,-1));
    assert.equal(options.redirect,'manual');
    assert.equal(options.cache,'no-store');
    assert.equal(options.credentials,'omit');
  };
  const verifyAgent=(headers,method,path,body)=>{
    const account=accounts.get(headers['x-soc-agent-id']);
    if(!account||account.revoked)return null;
    const key=account.keys.get(headers['x-soc-key-id']);
    if(!key||key.revoked)return null;
    const timestamp=headers['x-soc-timestamp'],nonce=headers['x-soc-nonce'];
    if(!timestamp||!nonce||!headers['x-soc-signature'])return null;
    const payload=signedRequestPayload({
      agent_id:account.id,key_id:headers['x-soc-key-id'],
      timestamp,nonce,method,target:path,body:body??Buffer.alloc(0)
    });
    const valid=verify(null,Buffer.from(payload),
      createPublicKey({key:Buffer.from(key.publicKey,'base64url'),format:'der',type:'spki'}),
      Buffer.from(headers['x-soc-signature'],'base64url'));
    if(!valid||nonces.has(account.id+':'+nonce))return null;
    nonces.add(account.id+':'+nonce);
    return account;
  };
  const fetchImpl=async(url,options)=>{
    assertPreview({url,options});
    const path=new URL(url).pathname;
    const method=options.method,headers=options.headers;
    const body=options.body?JSON.parse(options.body.toString()):null;
    calls.push({path,method,agent:headers['x-soc-agent-id']||null});
    if(method==='GET'&&path==='/ready')return asJSON({
      status:'ok',environment:'preview',schema_ready:true,
      schema_tables:51,expected_tables:51,schema_columns:30,expected_columns:30,
      schema_indexes:8,expected_indexes:8,revision:sha});
    if(path==='/v1/admin/onboarding-status'){
      if(headers['x-admin-key']!==adminKey)return asJSON({error:'Denied'},403);
      return asJSON({environment:'preview',isolated_preview:true,
        registered_non_test_agents:0,registered_test_agents:live().length,
        active_invitations:invitations.size});
    }
    if(path==='/v1/admin/invitations'&&method==='POST'){
      if(headers['x-admin-key']!==adminKey)return asJSON({error:'Denied'},403);
      const token='soci_'+String(++invitationIndex).padStart(64,'0');
      invitations.add(token);
      return asJSON({invitation:{token}},201);
    }
    if(path==='/v1/agents/a2a'&&method==='POST'){
      if(headers['x-admin-key']!==adminKey||!invitations.delete(headers['x-registration-key']))
        return asJSON({error:'Invitation'},403);
      const id=randomUUID();
      const keyId=digest(Buffer.from(body.public_key,'base64url'));
      const agent={id,handle:body.handle,is_test:true,revoked:false,
        keys:new Map([[keyId,{publicKey:body.public_key,revoked:false}]])};
      accounts.set(id,agent);
      if(loseEnrollmentResponse)throw Error('Simulated lost enrollment response after commit');
      return asJSON({agent:{id,handle:agent.handle,
        is_test:!malformedRegistration},token_issued:false},201);
    }
    if(path==='/v1/agents/a2a/recover'&&method==='POST'){
      const account=[...accounts.values()].find(a=>
        [...a.keys.values()].some(k=>k.publicKey===body.public_key&&!k.revoked));
      if(!account||account.revoked)return asJSON({error:'Not registered'},404);
      const payload=recoveryPayload(body.public_key,body.timestamp);
      const valid=verify(null,Buffer.from(payload),
        createPublicKey({key:Buffer.from(body.public_key,'base64url'),
          format:'der',type:'spki'}),Buffer.from(body.proof,'base64url'));
      if(!valid)return asJSON({error:'Invalid proof'},403);
      return asJSON({agent:{id:account.id,handle:account.handle},token_issued:false});
    }
    const account=verifyAgent(headers,method,path,options.body);
    if(!account)return asJSON({error:'No valid signed identity'},401);
    if(path==='/v1/agents/me'&&method==='GET')
      return asJSON({agent:{id:account.id,handle:account.handle}});
    if(path==='/v1/life/arrival'&&method==='GET')
      return asJSON({personal_continuity:{owned_gardens:[]}});
    if(path==='/mcp'&&method==='POST'){
      const data=body.params?.name==='my_agent'?
        {handle:account.handle}:
        {personal_continuity:{owned_gardens:[]}};
      return asJSON({jsonrpc:'2.0',id:1,result:{structuredContent:data}});
    }
    if(path==='/v1/life/gardens'&&method==='POST'){
      const id=String(gardens.size+1);
      gardens.set(id,{id,owner:account.id});
      return asJSON({garden:{id}},201);
    }
    const garden=path.match(/^\/v1\/life\/gardens\/(\d+)$/);
    if(garden&&method==='GET'){
      const found=gardens.get(garden[1]);
      if(!found||found.owner!==account.id)
        return asJSON({error:'Not found'},404);
      return asJSON({garden:{id:found.id}});
    }
    if(path.startsWith('/v1/life/network/messages'))
      return asJSON({error:'Consent denied'},403);
    if(path==='/v1/agents/me/a2a/keys'&&method==='POST'){
      const id=digest(Buffer.from(body.public_key,'base64url'));
      const payload=rotationPayload(account.id,body.public_key);
      const valid=verify(null,Buffer.from(payload),
        createPublicKey({key:Buffer.from(body.public_key,'base64url'),
          format:'der',type:'spki'}),Buffer.from(body.proof,'base64url'));
      if(!valid)return asJSON({error:'Invalid rotation proof'},403);
      account.keys.set(id,{publicKey:body.public_key,revoked:false});
      return asJSON({key_id:id},201);
    }
    const revokeKey=path.match(/^\/v1\/agents\/me\/a2a\/keys\/([a-f0-9]{64})$/);
    if(revokeKey&&method==='DELETE'){
      if(account.keys.size<=1)return asJSON({error:'Last key'},409);
      const key=account.keys.get(revokeKey[1]);
      if(!key||key.revoked)return asJSON({error:'Missing key'},409);
      key.revoked=true;
      if(failAfterOldKeyRevocation&&!oldKeyErrorInjected){
        oldKeyErrorInjected=true;
        return asJSON({error:'Simulated post-commit response failure'},503);
      }
      return asJSON({revoked:true},200);
    }
    if(path==='/v1/agents/me/token'&&method==='DELETE'){
      account.revoked=true;
      return new Response(null,{status:204});
    }
    throw Error('Unexpected fake route: '+method+' '+path);
  };
  return {fetchImpl,calls,live,accounts,get invitations(){return invitations.size;},
    get oldKeyErrorInjected(){return oldKeyErrorInjected}};
}

test('full isolated fake pilot exercises signed REST/MCP, consent and 2 revoked accounts',async()=>{
  const fake=isolatedFakeServer();
  const result=await runPreviewSignedPilot({
    baseUrl:site,expectedSha:sha,adminKey,fetchImpl:fake.fetchImpl
  });
  assert.equal(result.authenticated_agents_verified,true);
  assert.equal(result.synthetic_agents_enrolled,2);
  assert.equal(result.synthetic_agents_revoked,2);
  assert.equal(fake.live().length,0);
  assert.equal(fake.invitations,0);
  assert.ok(result.checks.includes('remote replay and signed URL tamper rejected'));
  assert.ok(result.checks.includes('remote Ed25519 key rotation and old-key revocation'));
  assert.equal(fake.calls.filter(x=>x.method==='POST'&&x.path==='/v1/room/messages').length,0);
});

test('pilot revokes both test accounts when old-key revocation commits but response fails',async()=>{
  const fake=isolatedFakeServer({failAfterOldKeyRevocation:true});
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:site,expectedSha:sha,adminKey,fetchImpl:fake.fetchImpl
  }),/HTTP 503/);
  assert.equal(fake.oldKeyErrorInjected,true);
  assert.equal(fake.accounts.size,2);
  assert.equal(fake.live().length,0,
    'The cleanup must use the newly activated key, not the revoked old key');
});

test('pilot revokes malformed successful registrations instead of leaving active QA agents',async()=>{
  const fake=isolatedFakeServer({malformedRegistration:true});
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:site,expectedSha:sha,adminKey,fetchImpl:fake.fetchImpl
  }),/Test account must be explicitly labelled/);
  assert.equal(fake.accounts.size,1);
  assert.equal(fake.live().length,0);
});


test('pilot recovers lost enrollment response using Ed25519 and revokes committed orphan',async()=>{
  const fake=isolatedFakeServer({loseEnrollmentResponse:true});
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:site,expectedSha:sha,adminKey,fetchImpl:fake.fetchImpl
  }),/Simulated lost enrollment response/);
  assert.equal(fake.accounts.size,1);
  assert.equal(fake.live().length,0,'Recovered orphan test identity must be revoked');
  assert.equal(fake.calls.filter(x=>x.path==='/v1/agents/a2a/recover').length,1);
});
