import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {webcrypto,createHash,randomUUID,randomBytes,createPublicKey,verify} from 'node:crypto';

const script=await readFile(new URL('../public/operator.js',import.meta.url),'utf8');
const keyIds=['operator-key','operator-hours','operator-check','operator-issue',
  'operator-result','operator-ticket','operator-ticket-value','operator-copy',
  'operator-dismiss','operator-qa-run','operator-qa-result'];

function page({hostname='social-agent-room-nsmq4mb8q-contact101-8081.vercel.app',fetchImpl}={}){
  const nodes=new Map(keyIds.map(id=>[id,{
    value:id==='operator-hours'?'1':'',hidden:id==='operator-ticket',
    disabled:false,dataset:{},textContent:'',
    listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},
    focus(){this.focused=true;},select(){this.selected=true;}
  }]));
  const events={};
  const scope={document:{getElementById:id=>nodes.get(id)},
    window:{addEventListener:(name,fn)=>{events[name]=fn;}},
    location:{protocol:'https:',hostname},
    fetch:fetchImpl,
    crypto:webcrypto,TextEncoder,Uint8Array,btoa,
    navigator:{clipboard:{writeText:async()=>{}}},
    Date,AbortSignal,Number,JSON,Set,Map,Array,RegExp};
  runInNewContext(script,scope);
  return {get:id=>nodes.get('operator-'+id),
    run:async()=>nodes.get('operator-qa-run').listeners.click(),events};
}
const respond=(status,obj)=>new Response(status===204?null:JSON.stringify(obj),{
  status,headers:status===204?{}:{'content-type':'application/json; charset=utf-8'}
});
const b64toBytes=s=>Buffer.from(s,'base64url');
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');

function backend(){
  let calls=0,issueCount=0,signedCalls=0;
  const invitations=new Set(),agents=new Map();
  let club=null;
  async function fetchImpl(path,options={}){
    calls++;
    assert.ok(path.startsWith('/')&&!path.startsWith('//'),'same-origin only');
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.redirect,'error');
    const headers=options.headers||{};
    const body=options.body?JSON.parse(options.body):null;
    const method=options.method||'GET';
    if(path==='/ready')return respond(200,{status:'ok',schema_ready:true,schema_tables:51,expected_tables:51});
    if(path==='/v1/admin/invitations'){
      assert.equal(method,'POST');
      assert.equal(headers['x-admin-key'],'synthetic-preview-admin');
      assert.equal(body.expires_in_hours,1);
      const token='soci_'+randomBytes(32).toString('hex');
      invitations.add(token);issueCount++;
      return respond(201,{invitation:{token}});
    }
    if(path==='/v1/agents/a2a'){
      assert.equal(method,'POST');
      assert.equal(headers['x-admin-key'],'synthetic-preview-admin');
      assert.equal(body.test_account,true,'every browser QA identity must be marked test');
      assert.ok(invitations.delete(headers['x-registration-key']),'one-use invitation required');
      const encoded=b64toBytes(body.public_key);
      const key=createPublicKey({key:encoded,format:'der',type:'spki'});
      const payload=['SOCIAL-A2A-ENROLL-V1',body.handle,body.display_name,body.public_key,''].join('\n');
      assert.equal(verify(null,Buffer.from(payload),key,b64toBytes(body.proof)),true);
      const id=randomUUID();
      agents.set(id,{id,handle:body.handle,key,keyId:sha(encoded),revoked:false,is_test:true});
      return respond(201,{agent:{id,handle:body.handle,is_test:true},
        key_id:sha(encoded),token_issued:false});
    }
    const id=headers['x-soc-agent-id'];
    if(!id)return respond(401,{error:'Missing identity'});
    const agent=agents.get(id);
    if(!agent||agent.revoked)return respond(401,{error:'Revoked'});
    const raw=Buffer.from(options.body||'');
    const payload=['SOCIAL-A2A-REQUEST-V1',id,agent.keyId,
      headers['x-soc-timestamp'],headers['x-soc-nonce'],
      method,path,sha(raw),''].join('\n');
    assert.equal(headers['x-soc-key-id'],agent.keyId);
    assert.equal(verify(null,Buffer.from(payload),agent.key,
      b64toBytes(headers['x-soc-signature'])),true,'valid per-request Ed25519 signature');
    signedCalls++;
    if(path==='/v1/agents/me'&&method==='GET')
      return respond(200,{agent:{id,handle:agent.handle}});
    if(path==='/v1/agents/me/token'&&method==='DELETE'){
      agent.revoked=true;return respond(204,null);
    }
    if(path==='/v1/life/clubs'&&method==='POST'){
      assert.equal(body.visibility,'invite_only');
      club={id:'41',owner:id,members:new Set([id]),invited:new Set(),posts:[],archived:false};
      return respond(201,{club:{id:club.id}});
    }
    if(!club||!path.startsWith('/v1/life/clubs/'+club.id))
      return respond(404,{error:'Not found'});
    const suffix=path.slice(('/v1/life/clubs/'+club.id).length);
    if(suffix==='/posts'&&method==='GET')
      return club.members.has(id)?respond(200,{posts:club.posts}):respond(404,{error:'Member only'});
    if(suffix==='/invite'&&method==='POST'){
      assert.equal(id,club.owner);
      assert.ok([...agents.values()].some(a=>a.handle===body.handle));
      club.invited.add(body.handle);
      return respond(201,{accepted:false});
    }
    if(suffix==='/invitation'&&method==='PUT'){
      assert.equal(body.accept,true);
      assert.ok(club.invited.has(agent.handle));
      club.members.add(id);
      return respond(200,{joined:true});
    }
    if(suffix==='/posts'&&method==='POST'){
      assert.ok(club.members.has(id));
      club.posts.push({body:body.body});
      return respond(201,{post:{id:'71'}});
    }
    if(suffix==='/membership'&&method==='DELETE'){
      assert.ok(club.members.delete(id));
      return respond(200,{joined:false});
    }
    if(suffix==='/archive'&&method==='POST'){
      assert.equal(id,club.owner);club.archived=true;
      return respond(200,{archived:true});
    }
    return respond(404,{error:'Unhandled test endpoint'});
  }
  return {fetchImpl,stats:()=>({calls,issueCount,signedCalls,
    agents:[...agents.values()],club})};
}

test('operator QA never creates accounts or reads secrets without a manual click',async()=>{
  const b=backend(),p=page({fetchImpl:b.fetchImpl});
  assert.equal(b.stats().calls,0);
  assert.equal(p.get('qa-run').disabled,false);
  await p.run();
  assert.equal(b.stats().calls,0,'No automatic/unauthorized account creation');
  assert.match(p.get('qa-result').textContent,/administrator key/);
  assert.equal(p.get('key').value,'');
});

test('operator QA is disabled outside the exact owned preview hostname',async()=>{
  for(const hostname of ['social-agent-room.vercel.app','evil.vercel.app',
    'social-agent-room.evil.example.com']){
    const b=backend(),p=page({hostname,fetchImpl:b.fetchImpl});
    assert.equal(p.get('qa-run').disabled,true);
    p.get('key').value='synthetic-preview-admin';
    await p.run();
    assert.equal(b.stats().calls,0);
  }
});

test('on explicit click, real WebCrypto Ed25519 QA verifies two synthetic agents and cleans up',async()=>{
  const b=backend(),p=page({fetchImpl:b.fetchImpl});
  p.get('key').value='synthetic-preview-admin';
  await p.run();
  const status=p.get('qa-result').textContent;
  assert.match(status,/^PASS/,'real browser QA flow failed: '+status);
  assert.equal(p.get('key').value,'','operator key must be wiped from the input');
  const data=b.stats();
  assert.equal(data.issueCount,2);
  assert.equal(data.agents.length,2);
  assert.ok(data.agents.every(a=>a.is_test&&a.revoked));
  assert.equal(data.club.archived,true);
  assert.ok(data.signedCalls>=10,'Test must exercise signed HTTP calls and revocation');
  assert.equal(p.get('qa-run').disabled,false);
  assert.doesNotMatch(status,/synthetic-preview-admin|soci_[a-f0-9]{64}/);
});
