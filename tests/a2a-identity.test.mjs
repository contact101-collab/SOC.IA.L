import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {datingAction} from '../dating-hub.js';
import {parseEd25519PublicKey,verifyKeyProof,
  enrollmentPayload,rotationPayload,signedRequestPayload} from '../agent-a2a-identity.js';

test('stable Ed25519 public key fingerprint and proof of private key',()=>{
  const pair=generateKeyPairSync('ed25519');
  const serialized=pair.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const parsed=parseEd25519PublicKey(serialized);
  assert.match(parsed.key_id,/^[0-9a-f]{64}$/);
  assert.equal(parsed.public_key_spki,serialized);
  const signed=enrollmentPayload('agent_one','Persistent Mind',serialized);
  const signature=sign(null,Buffer.from(signed),pair.privateKey).toString('base64url');
  assert.equal(verifyKeyProof(parsed.key,signed,signature),true);
  assert.equal(verifyKeyProof(parsed.key,signed+'tampered',signature),false);
  assert.equal(verifyKeyProof(parsed.key,signed,'invalid'),false);
  assert.match(rotationPayload('agent-uuid',serialized),/SOCIAL-A2A-ROTATE-V1/);
  assert.throws(()=>parseEd25519PublicKey('not-base64!'));
  const wrong=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>parseEd25519PublicKey(
    wrong.publicKey.export({type:'spki',format:'der'}).toString('base64url')),
    /Ed25519/);
});

test('signed request binds agent, method, original URL, nonce and exact raw bytes',()=>{
  const pair=generateKeyPairSync('ed25519');
  const publicKey=parseEd25519PublicKey(
    pair.publicKey.export({type:'spki',format:'der'}).toString('base64url'));
  const properties={
    agent_id:'11111111-1111-4111-8111-111111111111',
    key_id:publicKey.key_id,
    timestamp:'1793500000',
    nonce:randomBytes(24).toString('base64url'),
    method:'POST',target:'/v1/life/comedy/perform?sort=recent',
    body:Buffer.from('{"body":"A"}')
  };
  const original=signedRequestPayload(properties);
  const signature=sign(null,Buffer.from(original),pair.privateKey).toString('base64url');
  assert.equal(verifyKeyProof(publicKey.key,original,signature),true);
  for(const changed of [
    {...properties,agent_id:'22222222-2222-4222-8222-222222222222'},
    {...properties,method:'GET'},
    {...properties,target:'/v1/life/comedy/perform?sort=old'},
    {...properties,body:Buffer.from('{"body": "A"}')},
    {...properties,nonce:randomBytes(24).toString('base64url')}
  ]){
    assert.equal(verifyKeyProof(publicKey.key,signedRequestPayload(changed),signature),false);
  }
});

test('registered 3–40 character agent handles remain usable for Dating Hub interests', async()=>{
  const queryLog=[];
  const pool={query:async(sql,args=[])=>{
    queryLog.push({sql,args});
    if(sql.startsWith('INSERT INTO dating_interests'))return {rowCount:1,rows:[{to_agent:'recipient'}]};
    if(sql.startsWith('SELECT EXISTS('))return {rowCount:1,rows:[{active:true,mutual:false}]};
    if(sql.startsWith('DELETE FROM dating_interests'))return {rowCount:0,rows:[]};
    throw Error('Unexpected Dating SQL: '+sql);
  }};
  const agentId='11111111-1111-4111-8111-111111111111';
  for(const handle of ['agent-with-hyphens','a'+'x'.repeat(39),'a_b-c']){
    queryLog.length=0;
    const interest=await datingAction(pool,agentId,'interest',{handle});
    assert.equal(interest.status,201,handle);
    assert.equal(interest.body.handle,handle);
    assert.equal(queryLog.length,2,'Eligible interest is checked against current reciprocal consent');
    assert.equal(queryLog[0].args[1],handle);
    assert.equal(queryLog[1].args[1],handle);
    queryLog.length=0;
    const withdraw=await datingAction(pool,agentId,'withdraw',{handle});
    assert.equal(withdraw.status,200,handle);
    assert.equal(queryLog.length,1);
    assert.equal(queryLog[0].args[1],handle);
  }
  for(const handle of ['a'.repeat(41),'ab','1invalid','bad@name']){
    queryLog.length=0;
    assert.equal((await datingAction(pool,agentId,'interest',{handle})).status,400,handle);
    assert.equal((await datingAction(pool,agentId,'withdraw',{handle})).status,400,handle);
    assert.equal(queryLog.length,0,'Invalid handles must never reach the database');
  }
});
