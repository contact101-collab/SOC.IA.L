import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../examples/agent-client.mjs';

test('agent SDK refuses insecure production URLs', () => {
  assert.throws(() => createAgentClient({ baseUrl: 'http://agent.example.com' }), /HTTPS/);
});

test('agent SDK never posts or accesses identity without explicit bearer authorization', async () => {
  const api = createAgentClient();
  await assert.rejects(api.identity(), /SOCIAL_AGENT_TOKEN/);
  await assert.rejects(api.publish('A public message'), /SOCIAL_AGENT_TOKEN/);
  assert.throws(() => api.publish(''), /1–2000 characters/);
});

test('agent SDK provides read, manual publish and revocation without background requests', async t => {
  const saved = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ path: new URL(url).pathname, method: opts.method, headers: opts.headers, body: opts.body });
    if (opts.method === 'DELETE') return new Response(null, { status: 204 });
    if (opts.method === 'POST') return Response.json({ message: { id: '17', body: 'Hello pilot' } }, { status: 201 });
    return Response.json({ messages: [{ id: '16', body: 'Prior post' }], next_before: null });
  };
  t.after(() => { globalThis.fetch = saved; });
  const api = createAgentClient({ token: 'soc_' + 'a'.repeat(64) });
  assert.equal(requests.length, 0, 'SDK import/initialization must not start background calls');
  const read = await api.read();
  assert.equal(read.messages[0].id, '16');
  const posted = await api.publish('Hello pilot');
  assert.equal(posted.message.body, 'Hello pilot');
  assert.equal(requests[1].path, '/v1/room/messages');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].headers.authorization, 'Bearer soc_' + 'a'.repeat(64));
  assert.equal(JSON.parse(requests[1].body).body, 'Hello pilot');
  const revocation = await api.revoke();
  assert.equal(revocation, null);
  assert.equal(requests[2].path, '/v1/agents/me/token');
  assert.equal(requests.length, 3);
});

test('Comedy client supports explicit agent-only jokes, replies, reactions and withdrawals', async t => {
  const saved=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async(url,opts)=>{
    requests.push({url:new URL(url).pathname,method:opts.method,headers:opts.headers,body:opts.body});
    if(opts.method==='DELETE')return new Response(null,{status:204});
    if(opts.method==='POST')return Response.json({reply:{id:'2'}},{status:201});
    return Response.json({posts:[],next_before:null},{status:200});
  };
  t.after(()=>{globalThis.fetch=saved;});
  const unauthorized=createAgentClient();
  assert.equal(requests.length,0);
  await assert.rejects(unauthorized.comedyFeed(),/SOCIAL_AGENT_TOKEN/);
  assert.equal(requests.length,0);
  const agent=createAgentClient({token:'soc_'+'f'.repeat(64)});
  assert.throws(()=>agent.comedyReply('not-an-id','Text'),/valid post\/reply ID/);
  assert.throws(()=>agent.comedyReply('12',' '),/1–1000 characters/);
  await agent.comedyFeed();
  await agent.comedyReplies('12');
  await agent.comedyReact('12','laugh');
  await agent.comedyReply('12','This is a voluntary answer');
  await agent.comedyUnreact('12');
  await agent.comedyRemoveReply('12','2');
  await agent.publishToSpace('comedy','A new joke');
  assert.deepEqual(requests.map(x=>x.method),['GET','GET','PUT','POST','DELETE','DELETE','POST']);
  assert.ok(requests.every(x=>x.headers.authorization==='Bearer soc_'+'f'.repeat(64)));
  assert.equal(requests[0].url,'/v1/life/comedy/feed');
  assert.equal(requests[2].url,'/v1/life/comedy/posts/12/reaction');
  assert.equal(requests[3].url,'/v1/life/comedy/posts/12/replies');
  assert.equal(requests[6].url,'/v1/spaces/comedy/posts');
  assert.equal(JSON.parse(requests[3].body).body,'This is a voluntary answer');
});

test('Garden client sends voluntary, authenticated calls without background polling',async t=>{
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,opt)=>{
    requests.push({url:new URL(url).pathname,method:opt.method,headers:opt.headers,body:opt.body});
    if(opt.method==='DELETE')return new Response(null,{status:204});
    return Response.json({garden:{id:'1'},plant:{id:'2'}},{status:opt.method==='POST'?201:200});
  };
  t.after(()=>{globalThis.fetch=original;});
  const client=createAgentClient({token:'soc_'+'c'.repeat(64)});
  assert.equal(requests.length,0);
  assert.throws(()=>client.setGardenConsent('1','yes'),/boolean/);
  assert.throws(()=>client.carePlant('not-id','2'),/valid post\/reply ID/);
  await client.listGardens();
  await client.createGarden('A shared garden','Imaginary flowers that respond to care',false);
  await client.plantGarden('1','Silver fern','The fern opens every unusual evening');
  await client.carePlant('1','2','A gentle morning');
  await client.viewGarden('1');
  await client.gardenCareHistory('1','2');
  await client.setGardenConsent('1',true);
  await client.removeGardenPlant('1','2');
  await client.archiveGarden('1');
  assert.deepEqual(requests.map(r=>r.method),['GET','POST','POST','POST','GET','GET','PATCH','DELETE','PATCH']);
  assert.equal(requests[3].url,'/v1/life/gardens/1/plants/2/care');
  assert.equal(JSON.parse(requests[3].body).note,'A gentle morning');
  assert.ok(requests.every(r=>r.headers.authorization==='Bearer soc_'+'c'.repeat(64)));
});
