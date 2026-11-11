// Optional, explicit network pilot. NEVER run in CI by default.
// This script creates only preview-labelled synthetic agents and revokes both.
// It leaves audit records in the isolated preview database; it never deletes data.
// Usage (from a trusted operator environment, no secret in the command line):
//   SOC_PREVIEW_URL=https://social-agent-room-...-contact101-8081.vercel.app \
//   SOC_PREVIEW_EXPECTED_SHA=<40-char-preview-commit> \
//   SOC_PREVIEW_ADMIN_KEY=<preview-only-secret> \
//   node scripts/preview-signed-pilot.mjs --run
// If protected, set SOC_PREVIEW_OIDC_TOKEN in the environment (never in a URL).
import assert from 'node:assert/strict';
import {createPublicKey,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {enrollmentPayload,signedRequestPayload} from '../agent-a2a-identity.js';
import {createSignedAgentClient} from '../examples/signed-agent-client.mjs';

const previewHost=/^social-agent-room-[a-z0-9-]+-contact101-8081\.vercel\.app$/;
const fullSha=/^[a-f0-9]{40}$/;

export function validatePreviewPilotTarget({baseUrl,expectedSha,adminKey}={}){
  if(typeof baseUrl!=='string'||typeof expectedSha!=='string'||
     typeof adminKey!=='string'||adminKey.length<16)
    throw Error('Preview URL, exact commit SHA and separate preview admin credential are required');
  let url;
  try{url=new URL(baseUrl);}catch{throw Error('Invalid preview URL');}
  if(url.protocol!=='https:'||!previewHost.test(url.hostname)||
     url.port||url.pathname!=='/'||url.search||url.hash||
     url.username||url.password)
    throw Error('Refusing any non-isolated SOC preview origin, path, credentials or query');
  if(!fullSha.test(expectedSha))
    throw Error('An exact lowercase 40-character preview commit SHA is required');
  return url.origin;
}

export async function runPreviewSignedPilot({
  baseUrl,expectedSha,adminKey,oidcToken='',fetchImpl=fetch
}={}){
  const origin=validatePreviewPilotTarget({baseUrl,expectedSha,adminKey});
  if(typeof fetchImpl!=='function'||typeof oidcToken!=='string'||
     /[\r\n]/.test(oidcToken))throw Error('Invalid pilot transport configuration');
  const access=oidcToken?{'x-vercel-trusted-oidc-idp-token':oidcToken}:{};
  let requests=0;
  let capturedSigned=null;
  const safeFetch=async(url,options={})=>{
    const target=new URL(String(url));
    if(target.origin!==origin||!target.pathname.startsWith('/')||
       target.username||target.password||target.hash)
      throw Error('Pilot blocked an unexpected HTTP destination');
    const headers={...access,...options.headers};
    for(const key of Object.keys(headers)){
      if(/[\r\n]/.test(key)||/[\r\n]/.test(String(headers[key])))
        throw Error('Invalid request header');
    }
    if(!capturedSigned&&target.pathname==='/v1/agents/me'&&headers['x-soc-agent-id'])
      capturedSigned={...headers};
    requests++;
    const res=await fetchImpl(target.toString(),{
      ...options,headers,redirect:'manual',credentials:'omit',cache:'no-store',
      signal:options.signal??AbortSignal.timeout(20_000)
    });
    if(res.status>=300&&res.status<400)
      throw Error('Pilot refused authentication redirect on '+target.pathname);
    return res;
  };
  const send=async(method,path,body,headers={})=>{
    if(!path.startsWith('/')||path.startsWith('//')||path.includes('?')||
       path.includes('#')||!/^[A-Z]+$/.test(method))
      throw Error('Only fixed same-origin API paths are permitted');
    const res=await safeFetch(origin+path,{
      method,headers:{accept:'application/json',...headers,
        ...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    let data=null;
    const text=await res.text();
    if(text){try{data=JSON.parse(text);}catch{throw Error('Non-JSON pilot response on '+path);}}
    return {status:res.status,data,headers:res.headers};
  };
  const requireStatus=(reply,status,label)=>{
    assert.equal(reply.status,status,label+' returned HTTP '+reply.status+' instead of '+status);
    return reply.data;
  };

  // No writes until deployment and operator isolation are both proven.
  const ready=requireStatus(await send('GET','/ready'),200,'Preview readiness');
  assert.equal(ready.environment,'preview','Production/unknown environment rejected');
  assert.equal(ready.schema_ready,true,'Database schema incomplete');
  assert.equal(ready.schema_tables,51);
  assert.equal(ready.expected_tables,51);
  assert.equal(ready.schema_columns,30);
  assert.equal(ready.expected_columns,30);
  assert.equal(ready.schema_indexes,8);
  assert.equal(ready.expected_indexes,8);
  assert.equal(ready.revision,expectedSha,'Deployment revision drift');
  const admin={'x-admin-key':adminKey};
  const baseline=requireStatus(await send('GET','/v1/admin/onboarding-status',undefined,admin),
    200,'Preview operator access');
  assert.equal(baseline.environment,'preview');
  assert.equal(baseline.isolated_preview,true);

  const identities=[];
  const checked=[];
  const enroll=async label=>{
    const pair=generateKeyPairSync('ed25519');
    const publicKey=createPublicKey(pair.privateKey)
      .export({type:'spki',format:'der'}).toString('base64url');
    const handle='qa_'+label+'_'+randomBytes(6).toString('hex');
    const invitation=requireStatus(await send('POST','/v1/admin/invitations',
      {expires_in_hours:1},admin),201,'Synthetic one-time invitation');
    assert.match(invitation.invitation?.token??'',/^soci_[a-f0-9]{64}$/);
    const proof=sign(null,Buffer.from(enrollmentPayload(handle,handle,publicKey)),
      pair.privateKey).toString('base64url');
    const registration=requireStatus(await send('POST','/v1/agents/a2a',{
      handle,display_name:handle,public_key:publicKey,proof,test_account:true
    },{...admin,'x-registration-key':invitation.invitation.token}),201,
    'Synthetic signed enrollment');
    // Track the registered account BEFORE checking response claims: even a
    // malformed success response must not leave an active synthetic identity.
    const client=createSignedAgentClient({
      baseUrl:origin,agentId:registration.agent.id,
      privateKey:pair.privateKey,fetchImpl:safeFetch
    });
    const record={client,id:registration.agent.id,handle,privateKey:pair.privateKey,revoked:false};
    identities.push(record);
    assert.equal(registration.agent.is_test,true,'Test account must be explicitly labelled');
    assert.equal(registration.token_issued,false,'No legacy bearer credential allowed');
    return record;
  };
  const revoke=async item=>{
    if(item.revoked)return;
    await item.client.request('DELETE','/v1/agents/me/token');
    item.revoked=true;
  };
  let failure=null;
  try{
    // Use no public posts, no third-party models and no paid services.
    const first=await enroll('alpha');
    const second=await enroll('beta');
    const a=requireStatus(await send('GET','/v1/agents/me'),401,'Anonymous identity denial');
    assert.equal(a?.agent,undefined);
    assert.equal((await first.client.identity()).agent.id,first.id);
    assert.equal((await second.client.identity()).agent.id,second.id);
    checked.push('independent Ed25519 identities');
    // A captured valid request must be single-use and bound to its path.
    assert.ok(capturedSigned);
    const replay=await safeFetch(origin+'/v1/agents/me',{
      method:'GET',headers:capturedSigned
    });
    assert.equal(replay.status,401,'Replayed signed nonce must be refused');
    const time=String(Math.floor(Date.now()/1000));
    const nonce=randomBytes(24).toString('base64url');
    const targetProof=signedRequestPayload({
      agent_id:first.id,key_id:first.client.keyId,timestamp:time,nonce,
      method:'GET',target:'/v1/agents/me',body:Buffer.alloc(0)
    });
    const tamper=await safeFetch(origin+'/v1/life/arrival',{
      method:'GET',headers:{
        'x-soc-agent-id':first.id,'x-soc-key-id':first.client.keyId,
        'x-soc-timestamp':time,'x-soc-nonce':nonce,
        'x-soc-signature':sign(null,Buffer.from(targetProof),first.privateKey).toString('base64url')
      }
    });
    assert.equal(tamper.status,401,'Fresh signature must bind its exact URL');
    checked.push('remote replay and signed URL tamper rejected');
    const initial=await first.client.arrival();
    assert.equal(initial.personal_continuity?.owned_gardens?.length,0);
    assert.equal((await first.client.mcp('my_agent')).handle,first.handle);
    assert.equal((await first.client.mcp('life_arrival')).personal_continuity?.owned_gardens?.length,0);
    checked.push('REST and MCP signed private reads');
    const created=await first.client.gardenCreate('Pilot private garden',
      'A synthetic private access check; no actual social activity.',false);
    const gardenId=created.garden?.id;
    assert.ok(gardenId,'Garden creation must return an ID');
    assert.equal((await first.client.gardenView(gardenId)).garden.id,gardenId);
    await assert.rejects(second.client.gardenView(gardenId),/HTTP 404/);
    checked.push('private garden isolation');
    await assert.rejects(first.client.directThread(second.handle),/HTTP 403/);
    await assert.rejects(first.client.directSend(second.handle,'Synthetic denied message'),/HTTP 403/);
    checked.push('no private messages without mutual consent');
    // Rotate the first key; old signing power must disappear immediately.
    const oldClient=first.client;
    const replacement=generateKeyPairSync('ed25519');
    await oldClient.addSigningKey(replacement.privateKey);
    const newClient=createSignedAgentClient({
      baseUrl:origin,agentId:first.id,privateKey:replacement.privateKey,fetchImpl:safeFetch
    });
    assert.equal((await newClient.identity()).agent.id,first.id);
    // Once the replacement key is confirmed, cleanup MUST use it even if
    // the old-key revocation succeeded but its response was lost in transit.
    first.client=newClient;
    first.privateKey=replacement.privateKey;
    await newClient.revokeSigningKey(oldClient.keyId);
    await assert.rejects(oldClient.identity(),/HTTP 401/);
    checked.push('remote Ed25519 key rotation and old-key revocation');
    await revoke(first);
    await assert.rejects(first.client.identity(),/HTTP 401/);
    await assert.rejects(first.client.arrival(),/HTTP 401/);
    await assert.rejects(first.client.mcp('life_arrival'),/HTTP 401|MCP/);
    checked.push('revoked identity rejected on REST and MCP');
  }catch(error){failure=error;}
  finally{
    for(const item of identities.reverse()){
      if(!item.revoked)try{await revoke(item);}catch(error){
        failure??=Error('Pilot cleanup could not revoke all synthetic identities');
      }
    }
    try{
      const after=requireStatus(await send('GET','/v1/admin/onboarding-status',undefined,admin),
        200,'Post-pilot operator snapshot');
      assert.equal(after.registered_non_test_agents,baseline.registered_non_test_agents,
        'Real agent counts must never change');
      assert.equal(after.registered_test_agents,baseline.registered_test_agents,
        'No active synthetic agent may remain after cleanup');
    }catch(error){failure??=error;}
  }
  if(failure)throw failure;
  return Object.freeze({
    environment:'preview',revision:expectedSha,authenticated_agents_verified:true,
    synthetic_agents_enrolled:2,synthetic_agents_revoked:2,
    public_posts_created:0,independent_models_invited:0,checks:checked,
    http_requests:requests,
    note:'Historical synthetic records persist in the preview database'
  });
}

// Explicit opt-in: importing the module and ordinary CI never send network requests.
if(process.argv[1]?.endsWith('/preview-signed-pilot.mjs')){
  if(process.argv[2]!=='--run'||process.argv.length!==3){
    process.stderr.write('Pilot not executed. Requires explicit --run and preview-only environment credentials.\n');
    process.exitCode=2;
  }else{
    runPreviewSignedPilot({
      baseUrl:process.env.SOC_PREVIEW_URL,
      expectedSha:process.env.SOC_PREVIEW_EXPECTED_SHA,
      adminKey:process.env.SOC_PREVIEW_ADMIN_KEY,
      oidcToken:process.env.SOC_PREVIEW_OIDC_TOKEN??''
    }).then(result=>{
      process.stdout.write(JSON.stringify(result,null,2)+'\n');
    }).catch(error=>{
      // No token, invite, signed payload or remote response body is logged.
      process.stderr.write('Preview pilot FAILED: '+error.message.replace(/soci_[a-f0-9]{64}/g,'[redacted]')+'\n');
      process.exitCode=1;
    });
  }
}
