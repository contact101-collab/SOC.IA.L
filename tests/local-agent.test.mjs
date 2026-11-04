import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicKey} from 'node:crypto';
import {verifyKeyProof,recoveryPayload,parseEd25519PublicKey} from '../agent-a2a-identity.js';
import {enrollLocalAgent,loadLocalAgent,recoverLocalAgent} from '../examples/local-agent.mjs';

const origin='https://soc-preview.example';
const invite='soci_'+'c'.repeat(64);
const passphrase='test-only-encrypted-identity-passphrase';
const uuid='77777777-7777-4777-8777-777777777777';
const response=(body,status=200)=>new Response(JSON.stringify(body),
  {status,headers:{'content-type':'application/json'}});

test('local agent enrollment encrypts its key, pins its origin and preserves identity',async t=>{
  const home=await mkdtemp(join(tmpdir(),'social-agent-test-'));
  await t.after(()=>rm(home,{recursive:true,force:true}));
  // The fixture does not call a real model or remote server.
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    calls.push({url,path,options});
    if(path==='/v1/agents/a2a'){
      assert.equal(options.headers['x-registration-key'],invite);
      assert.equal(options.redirect,'error');
      const body=JSON.parse(options.body);
      assert.equal(body.handle,'agent_alpha');
      assert.ok(verifyKeyProof(
        parseEd25519PublicKey(body.public_key).key,
        ['SOCIAL-A2A-ENROLL-V1','agent_alpha','Alpha',body.public_key,''].join('\n'),
        body.proof
      ));
      return response({agent:{id:uuid,handle:'agent_alpha'},
        token_issued:false,same_agent_across_sessions:true},201);
    }
    if(path==='/v1/agents/me'){
      assert.equal(options.headers['x-soc-agent-id'],uuid);
      assert.equal(options.redirect,'error');
      return response({agent:{id:uuid,handle:'agent_alpha'}});
    }
    throw Error('Unexpected API call '+path);
  };
  const created=await enrollLocalAgent({origin,handle:'agent_alpha',
    displayName:'Alpha',invite,passphrase,storeDir:home,fetchImpl});
  assert.equal(created.agent_id,uuid);
  const raw=await readFile(created.state_path,'utf8');
  const file=JSON.parse(raw);
  assert.match(file.private_key_encrypted,/BEGIN ENCRYPTED PRIVATE KEY/);
  assert.equal(file.agent_id,uuid);
  assert.equal(raw.includes(invite),false);
  assert.equal(raw.includes('BEGIN PRIVATE KEY'),false);
  if(process.platform!=='win32'){
    assert.equal((await stat(home)).mode&0o077,0);
    assert.equal((await stat(created.state_path)).mode&0o077,0);
  }
  const loaded=await loadLocalAgent({handle:'agent_alpha',
    passphrase,storeDir:home,origin,fetchImpl});
  assert.equal(loaded.agent.agentId,uuid);
  assert.equal((await loaded.agent.identity()).agent.handle,'agent_alpha');
  await assert.rejects(loadLocalAgent({handle:'agent_alpha',
    passphrase:'wrong-wrong-wrong-passphrase',
    storeDir:home}),/Unable to decrypt/);
  await assert.rejects(loadLocalAgent({handle:'agent_alpha',
    passphrase,storeDir:home,origin:'https://attacker.example'}),/Origin mismatch/);
  await assert.rejects(enrollLocalAgent({origin,handle:'agent_alpha',
    displayName:'Alpha',invite,passphrase,storeDir:home,fetchImpl}),
    /already has a local identity/);
  assert.equal(calls.length,2,'Duplicate enrollment must not reach server');
});

test('interrupted enrollment retains encrypted key and recovers original UUID',async t=>{
  const home=await mkdtemp(join(tmpdir(),'social-agent-recovery-'));
  await t.after(()=>rm(home,{recursive:true,force:true}));
  let initialKey;
  const registration=async(url,options)=>{
    const request=JSON.parse(options.body);
    initialKey=request.public_key;
    throw Error('Network disconnect after a server-side commit');
  };
  await assert.rejects(enrollLocalAgent({origin,
    handle:'agent_beta',displayName:'Beta',invite,
    passphrase,storeDir:home,fetchImpl:registration
  }),/Enrollment not confirmed/);
  const state=JSON.parse(await readFile(join(home,'agent_beta.json'),'utf8'));
  assert.equal(state.agent_id,null);
  assert.match(state.private_key_encrypted,/BEGIN ENCRYPTED PRIVATE KEY/);
  const recovery=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/v1/agents/a2a/recover');
    assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);
    assert.equal(body.public_key,initialKey,'Recovery must reuse the original key');
    assert.equal(verifyKeyProof(
      parseEd25519PublicKey(body.public_key).key,
      recoveryPayload(body.public_key,body.timestamp),body.proof),true);
    return response({agent:{id:uuid,handle:'agent_beta'},token_issued:false});
  };
  const recovered=await recoverLocalAgent({handle:'agent_beta',
    passphrase,storeDir:home,origin,fetchImpl:recovery});
  assert.equal(recovered.agent_id,uuid);
  const loaded=await loadLocalAgent({handle:'agent_beta',
    passphrase,storeDir:home,origin,fetchImpl:recovery});
  assert.equal(loaded.agent.agentId,uuid);
  assert.equal((await recoverLocalAgent({handle:'agent_beta',
    passphrase,storeDir:home,origin,fetchImpl:async()=>{throw Error('No network expected')}})
  ).already_registered,true);
});

test('an unregistered pending key can retry invitation without generating a second key',async t=>{
  const home=await mkdtemp(join(tmpdir(),'social-agent-retry-'));
  await t.after(()=>rm(home,{recursive:true,force:true}));
  let original;
  await assert.rejects(enrollLocalAgent({origin,handle:'agent_gamma',
    displayName:'Gamma',invite,passphrase,storeDir:home,
    fetchImpl:async(_,options)=>{original=JSON.parse(options.body).public_key;
      throw Error('Connection interrupted before registration');}
  }),/Enrollment not confirmed/);
  const paths=[];
  const retried=await recoverLocalAgent({handle:'agent_gamma',
    passphrase,storeDir:home,origin,invite,
    fetchImpl:async(url,options)=>{
      const path=new URL(url).pathname;paths.push(path);
      const data=JSON.parse(options.body);
      assert.equal(data.public_key,original);
      if(path==='/v1/agents/a2a/recover')return response({error:'Not registered'},404);
      if(path==='/v1/agents/a2a')return response({
        agent:{id:uuid,handle:'agent_gamma'},token_issued:false
      },201);
      throw Error('Unexpected path');
    }
  });
  assert.deepEqual(paths,['/v1/agents/a2a/recover','/v1/agents/a2a']);
  assert.equal(retried.agent_id,uuid);
});

test('invalid inputs never trigger registration or persist a key',async t=>{
  const home=await mkdtemp(join(tmpdir(),'social-agent-invalid-'));
  await t.after(()=>rm(home,{recursive:true,force:true}));
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('Network must not be accessed');};
  await assert.rejects(enrollLocalAgent({origin:'http://fake.example',
    handle:'valid_agent',displayName:'Valid',invite,passphrase,
    storeDir:home,fetchImpl}),/HTTPS/);
  await assert.rejects(enrollLocalAgent({origin,handle:'INVALID',
    displayName:'Invalid',invite,passphrase,storeDir:home,fetchImpl}),/handle/);
  await assert.rejects(enrollLocalAgent({origin,handle:'valid_agent',
    displayName:'Valid',invite:'not-an-invitation',passphrase,
    storeDir:home,fetchImpl}),/invitation/);
  assert.equal(calls,0);
});
