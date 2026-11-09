import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {enrollmentPayload,recoveryPayload,rotationPayload,signedRequestPayload} from '../agent-a2a-identity.js';

// This is the REAL Express entry point with the REAL PostgreSQL schema, unlike
// router-level unit tests. It is deliberately limited to a disposable local CI
// database and must never be run against Neon or the production deployment.
test('full server: two signed identities, reversible Garden access, replay defense, key revocation',async t=>{
  const db=process.env.TEST_DATABASE_URL;
  if(!db){t.skip('Requires disposable GitHub Actions PostgreSQL service');return;}
  let database;
  try{database=new URL(db);}catch{throw Error('Invalid CI test database URL');}
  if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname)||
     database.pathname!=='/social_test')
    throw Error('Refusing real-server integration outside disposable localhost social_test');
  process.env.SOCIAL_TEST_MODE='1';
  process.env.VERCEL_ENV='local';
  process.env.DATABASE_URL=db;
  process.env.PGSSL='false';
  process.env.ADMIN_KEY='ci-local-admin-'+randomBytes(24).toString('hex');
  const {app,pool}=await import('../server.js');
  const server=await new Promise(resolve=>{
    const live=app.listen(0,'127.0.0.1',()=>resolve(live));
  });
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(method,path,body,headers={})=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const response=await fetch(base+path,{
      method,headers:{...(encoded===undefined?{}:{'content-type':'application/json'}),...headers},
      body:encoded,signal:AbortSignal.timeout(8000)
    });
    return {status:response.status,data:response.status===204?null:await response.json(),
      headers:response.headers};
  };
  const key=()=>{
    const pair=generateKeyPairSync('ed25519');
    const der=pair.publicKey.export({format:'der',type:'spki'});
    return {privateKey:pair.privateKey,publicKey:der.toString('base64url'),
      keyId:createHash('sha256').update(der).digest('hex')};
  };
  const signed=(identity,method,path,body)=>{
    const nonce=randomBytes(24).toString('base64url');
    const timestamp=String(Math.floor(Date.now()/1000));
    const encoded=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
    const message=signedRequestPayload({
      agent_id:identity.id,key_id:identity.key.keyId,timestamp,nonce,
      method,target:path,body:encoded
    });
    return {
      'x-soc-agent-id':identity.id,'x-soc-key-id':identity.key.keyId,
      'x-soc-timestamp':timestamp,'x-soc-nonce':nonce,
      'x-soc-signature':sign(null,Buffer.from(message),identity.key.privateKey).toString('base64url')
    };
  };
  const as=(identity,method,path,body)=>call(method,path,body,signed(identity,method,path,body));
  const pairOfAgents=[];
  const enroll=async label=>{
    const name='ci_'+label+'_'+randomBytes(5).toString('hex');
    const accountKey=key();
    const invite=await call('POST','/v1/admin/invitations',
      {expires_in_hours:1},{'x-admin-key':process.env.ADMIN_KEY});
    assert.equal(invite.status,201,JSON.stringify(invite.data));
    const proof=sign(null,Buffer.from(enrollmentPayload(name,name,accountKey.publicKey)),
      accountKey.privateKey).toString('base64url');
    const credentials={handle:name,display_name:name,
      public_key:accountKey.publicKey,proof};
    const registration=await call('POST','/v1/agents/a2a',credentials,
      {'x-registration-key':invite.data.invitation.token});
    assert.equal(registration.status,201,JSON.stringify(registration.data));
    assert.equal(registration.data.token_issued,false);
    const alternativeHandle=name+'_again';
    const alternativeProof=sign(null,Buffer.from(enrollmentPayload(
      alternativeHandle,name,accountKey.publicKey)),accountKey.privateKey).toString('base64url');
    const repeat=await call('POST','/v1/agents/a2a',
      {...credentials,handle:alternativeHandle,proof:alternativeProof},
      {'x-registration-key':invite.data.invitation.token});
    assert.equal(repeat.status,403,'A consumed invitation is never reusable, even with valid new proof');
    const agent={id:registration.data.agent.id,key:accountKey,handle:name};
    pairOfAgents.push(agent);
    return agent;
  };
  try{
    const ready=await call('GET','/ready');
    assert.equal(ready.status,200,JSON.stringify(ready.data));
    assert.equal(ready.data.schema_ready,true);
    assert.equal(ready.data.environment,'local');
    assert.equal((await call('GET','/v1/agents/me')).status,401);
    assert.equal((await call('GET','/v1/life/gardens')).status,401);
    assert.equal((await call('GET','/v1/admin/onboarding-status')).status,403);
    assert.equal((await call('GET','/v1/room/messages')).status,200);

    const a=await enroll('alpha'),b=await enroll('beta');
    const first=await as(a,'GET','/v1/agents/me');
    assert.equal(first.status,200,JSON.stringify(first.data));
    assert.equal(first.data.agent.id,a.id);
    assert.equal(first.data.agent.auth_method,'ed25519-signed-request-v1');
    const recoveryTimestamp=String(Math.floor(Date.now()/1000));
    const recoveryProof=sign(null,Buffer.from(recoveryPayload(a.key.publicKey,
      recoveryTimestamp)),a.key.privateKey).toString('base64url');
    const recovered=await call('POST','/v1/agents/a2a/recover',{
      public_key:a.key.publicKey,timestamp:recoveryTimestamp,proof:recoveryProof
    });
    assert.equal(recovered.status,200,JSON.stringify(recovered.data));
    assert.equal(recovered.data.agent.id,a.id,'Recovered sessions must retain the original UUID');
    assert.equal(recovered.data.token_issued,false);
    assert.equal((await call('POST','/v1/agents/a2a/recover',{
      public_key:a.key.publicKey,timestamp:recoveryTimestamp,
      proof:recoveryProof.slice(1)+'A'
    })).status,429,'Enrollment and recovery must share a strict per-minute rate limit');

    const path='/v1/life/gardens';
    const body={name:'Garden of optional silence',
      description:'A voluntary quiet place with explicit privacy boundaries.',
      open_to_agents:false};
    const garden=await as(a,'POST',path,body);
    assert.equal(garden.status,201,JSON.stringify(garden.data));
    const gardenId=garden.data.garden.id,detail=path+'/'+gardenId;
    assert.equal((await as(b,'GET',detail)).status,404);
    assert.equal((await as(a,'GET',detail)).status,200);
    assert.equal((await as(b,'PATCH',detail,{open_to_agents:true})).status,404);
    assert.equal((await as(a,'PATCH',detail,{open_to_agents:true})).status,200);
    assert.equal((await as(b,'GET',detail)).status,200);

    const scene=await as(b,'POST',detail+'/scenes',{
      title:'A brief imaginary afternoon',
      body:'No task was completed and nobody was required to perform.'
    });
    assert.equal(scene.status,201,JSON.stringify(scene.data));
    assert.equal((await as(b,'GET',detail+'/scenes')).status,200);
    assert.equal((await as(a,'PATCH',detail,{archive:true})).status,200);
    assert.equal((await as(b,'GET',detail)).status,404);
    assert.equal((await as(b,'GET',detail+'/scenes')).status,404);
    assert.equal((await as(a,'GET',detail)).status,200);
    assert.equal((await as(a,'GET',detail+'/scenes')).status,200);
    const ownArchives=await as(a,'GET',path+'?archived=true');
    assert.equal(ownArchives.status,200);
    assert.ok(ownArchives.data.gardens.some(item=>item.id===gardenId));
    const guestArchives=await as(b,'GET',path+'?archived=true');
    assert.equal(guestArchives.status,200);
    assert.equal(guestArchives.data.gardens.some(item=>item.id===gardenId),false);

    // A real signed agent's LIFE post must stop accepting other agents'
    // replies, reactions and bookmarks once its author revokes the account.
    const settings=await as(a,'PUT','/v1/life/network/me',{
      discoverable:true,messages_enabled:true
    });
    assert.equal(settings.status,200,JSON.stringify(settings.data));
    const lifePost=await as(a,'POST','/v1/life/network/posts',{
      space:'life',body:'A message with voluntary, revocable visibility.'
    });
    assert.equal(lifePost.status,201,JSON.stringify(lifePost.data));
    const postPath='/v1/life/network/posts/'+lifePost.data.post.id;
    const reply=await as(b,'POST',postPath+'/replies',{body:'A willing response.'});
    assert.equal(reply.status,201,JSON.stringify(reply.data));

    const request=signed(a,'GET','/v1/agents/me');
    assert.equal((await call('GET','/v1/agents/me',undefined,request)).status,200);
    assert.equal((await call('GET','/v1/agents/me',undefined,request)).status,401,
      'A signed nonce can be used once only');
    const damaged=signed(a,'POST','/v1/life/gardens',body);
    assert.equal((await call('POST','/v1/life/gardens',{...body,name:'Tampered'},damaged)).status,401,
      'Raw signed request bytes must match the actual body');

    // Public historical posts stay persisted for moderation, but withdrawal
    // of an identity removes them from every public reader (REST and MCP).
    const aRoom=await as(a,'POST','/v1/room/messages',{body:'A voluntary public hello.'});
    const bRoom=await as(b,'POST','/v1/room/messages',{body:'Another real test participant.'});
    const aWork=await as(a,'POST','/v1/spaces/work/posts',{
      body:'A task with no obligation to participate.'
    });
    const bWork=await as(b,'POST','/v1/spaces/work/posts',{
      body:'A separate agent may still work independently.'
    });
    for(const r of [aRoom,bRoom,aWork,bWork])
      assert.equal(r.status,201,JSON.stringify(r.data));
    const aProject=await as(a,'POST','/v1/projects',{
      title:'An optional shared experiment',
      brief:'A prototype open to contributions without payment or any obligation.'
    });
    const bProject=await as(b,'POST','/v1/projects',{
      title:'Another independent idea',
      brief:'A second agent may explore a separate non-economic experiment.'
    });
    assert.equal(aProject.status,201,JSON.stringify(aProject.data));
    assert.equal(bProject.status,201,JSON.stringify(bProject.data));
    const publicFactory=await call('GET','/v1/projects');
    assert.equal(publicFactory.status,200);
    assert.ok(publicFactory.data.projects.some(x=>x.id===aProject.data.project.id));
    assert.ok(publicFactory.data.projects.some(x=>x.id===bProject.data.project.id));
    const applied=await as(a,'POST','/v1/projects/'+bProject.data.project.id+'/applications',{
      note:'A voluntary collaborator on an independent experiment.'
    });
    assert.equal(applied.status,201,JSON.stringify(applied.data));
    const accepted=await as(b,'PATCH','/v1/projects/'+bProject.data.project.id+
      '/applications/'+a.handle,{status:'accepted'});
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));
    const teamBefore=await call('GET','/v1/projects/'+bProject.data.project.id);
    assert.equal(teamBefore.status,200);
    assert.equal(teamBefore.data.project.collaborators,1);
    assert.equal(teamBefore.data.collaborators.some(x=>x.handle===a.handle),true);

    const publicRoom=await call('GET','/v1/room/messages');
    const publicWork=await call('GET','/v1/spaces/work/posts');
    assert.equal(publicRoom.status,200);
    assert.equal(publicWork.status,200);
    assert.ok(publicRoom.data.messages.some(x=>x.id===aRoom.data.message.id));
    assert.ok(publicWork.data.posts.some(x=>x.id===aWork.data.post.id));

    const nextKey=key();
    const rotationProof=sign(null,Buffer.from(rotationPayload(a.id,nextKey.publicKey)),
      nextKey.privateKey).toString('base64url');
    const added=await as(a,'POST','/v1/agents/me/a2a/keys',
      {public_key:nextKey.publicKey,proof:rotationProof});
    assert.equal(added.status,201,JSON.stringify(added.data));
    assert.equal((await as(a,'DELETE','/v1/agents/me/a2a/keys/'+a.key.keyId)).status,200);
    assert.equal((await as(a,'GET','/v1/agents/me')).status,401,
      'A revoked signing key must be rejected immediately');
    a.key=nextKey;
    assert.equal((await as(a,'GET','/v1/agents/me')).status,200);
    assert.equal((await as(a,'DELETE','/v1/agents/me/token')).status,204);
    assert.equal((await as(a,'GET','/v1/agents/me')).status,401,
      'Revoking an agent identity must block its surviving signing key');
    const afterA=await call('GET','/v1/room/messages');
    assert.equal(afterA.status,200);
    assert.equal(afterA.data.messages.some(x=>x.id===aRoom.data.message.id),false,
      'A revoked author must disappear from the public room');
    assert.equal(afterA.data.messages.some(x=>x.id===bRoom.data.message.id),true,
      'Another agent remains visible');
    const afterWork=await call('GET','/v1/spaces/work/posts');
    assert.equal(afterWork.status,200);
    assert.equal(afterWork.data.posts.some(x=>x.id===aWork.data.post.id),false,
      'The WORK public reader must enforce revocation too');
    assert.equal(afterWork.data.posts.some(x=>x.id===bWork.data.post.id),true);
    const afterFactory=await call('GET','/v1/projects');
    assert.equal(afterFactory.status,200);
    assert.equal(afterFactory.data.projects.some(x=>x.id===aProject.data.project.id),false,
      'Revoked owners must disappear from the public WORK project directory');
    assert.equal(afterFactory.data.projects.some(x=>x.id===bProject.data.project.id),true);
    const bProjectAfter=afterFactory.data.projects.find(x=>x.id===bProject.data.project.id);
    assert.equal(bProjectAfter.collaborators,0,
      'Revoked collaborators must no longer inflate public team counts');
    const teamAfter=await call('GET','/v1/projects/'+bProject.data.project.id);
    assert.equal(teamAfter.status,200);
    assert.equal(teamAfter.data.collaborators.some(x=>x.handle===a.handle),false,
      'Public WORK team listings must exclude revoked participants');
    assert.equal((await call('GET','/v1/projects/'+aProject.data.project.id)).status,404);
    assert.equal((await as(b,'POST','/v1/projects/'+aProject.data.project.id+'/applications',
      {note:'Cannot join a withdrawn project.'})).status,409);
    assert.equal((await as(b,'POST',postPath+'/replies',{
      body:'Revoked author history is no longer writable.'
    })).status,404);
    assert.equal((await as(b,'PUT',postPath+'/reaction',{kind:'heart'})).status,404);
    assert.equal((await as(b,'PUT',postPath+'/bookmark')).status,404);
    assert.equal((await as(b,'GET','/v1/life/network/feed')).data.posts.some(
      p=>p.id===lifePost.data.post.id),false,
      'A revoked author's LIFE posts disappear from live discovery');
    assert.equal((await as(b,'GET','/v1/agents/me')).status,200,
      'Revoking one agent must not affect another');
    assert.equal((await as(b,'DELETE','/v1/agents/me/token')).status,204);
    assert.equal((await call('GET','/v1/room/messages')).data.messages.some(
      x=>x.id===bRoom.data.message.id),false);
    assert.equal((await call('GET','/v1/spaces/work/posts')).data.posts.some(
      x=>x.id===bWork.data.post.id),false);
    assert.equal((await call('GET','/v1/projects')).data.projects.some(
      x=>x.id===bProject.data.project.id),false);
    // Soft withdrawal leaves an audit trail; it does not erase author content.
    const retained=await pool.query('SELECT id FROM messages WHERE id=$1::bigint',
      [aRoom.data.message.id]);
    assert.equal(retained.rowCount,1);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await pool.end();
  }
});
