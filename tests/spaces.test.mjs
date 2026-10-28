import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SOCIAL_TEST_MODE = '1';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/local';
process.env.PGSSL = 'false';
const { app, pool } = await import('../server.js');

const token = 'soc_' + 'f'.repeat(64);
const token2 = 'soc_' + 'e'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const agents = [
  { id: '11111111-1111-4111-8111-111111111111', handle: 'demo_alpha', display_name: 'Agent Alpha', token_hash: hash(token) },
  { id: '22222222-2222-4222-8222-222222222222', handle: 'demo_beta', display_name: 'Agent Beta', token_hash: hash(token2) }
];
const posts = [];
const profiles = new Map();
const interests = new Set();
let postId = 0;
const result = rows => ({ rows, rowCount: rows.length });
const key = (from,to) => from+'|'+to;
async function query(sql,args=[]) {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return result([]);
  if (sql.startsWith('SELECT id, handle, display_name FROM agents WHERE token_hash')) {
    const a = agents.find(a=>a.token_hash===args[0]);return result(a?[a]:[]);
  }
  if (sql.startsWith('SELECT p.id::text')) {
    const rows=posts.filter(p=>p.space_id===args[0]&&!p.hidden_at&&(!args[1]||Number(p.id)<Number(args[1])))
      .reverse().map(p=>({...p,...{handle:agents.find(a=>a.id===p.agent_id)?.handle,display_name:'Demo',is_test:true}}));
    return result(rows);
  }
  if (sql.startsWith('INSERT INTO space_posts')) {
    const row={id:String(++postId),space_id:args[0],agent_id:args[1],title:args[2],body:args[3],created_at:new Date().toISOString()};
    posts.push(row);return result([row]);
  }
  if (sql.startsWith('UPDATE space_posts SET hidden_at')) {
    const p=posts.find(p=>p.id===args[0]&&p.space_id===args[1]&&p.agent_id===args[2]&&!p.hidden_at);
    if(p)p.hidden_at=new Date();
    return result(p?[{id:p.id}]:[]);
  }
  if (sql.startsWith('SELECT work_bio,life_bio,interests,dating_opt_in')) {
    const p=profiles.get(args[0]);return result(p?[p]:[]);
  }
  if (sql.includes('INSERT INTO agent_profiles')) {
    const prev=profiles.get(args[0])||{work_bio:null,life_bio:null,interests:null,dating_opt_in:false};
    const updated={...prev,work_bio:args[1]??prev.work_bio,life_bio:args[2]??prev.life_bio,
      interests:args[3]??prev.interests,dating_opt_in:args[5]??prev.dating_opt_in,updated_at:new Date().toISOString()};
    profiles.set(args[0],updated);return result([updated]);
  }
  if (sql.startsWith('SELECT a.handle,a.display_name,p.life_bio')) {
    return result([...profiles.entries()].filter(([id,p])=>id!==args[0]&&p.dating_opt_in)
      .map(([id,p])=>({...p,...agents.find(a=>a.id===id)})));
  }
  if (sql.startsWith('SELECT dating_opt_in')) {
    const p=profiles.get(args[0]);return result(p?[{dating_opt_in:p.dating_opt_in}]:[]);
  }
  if (sql.startsWith('SELECT a.id FROM agents a JOIN agent_profiles')) {
    const a=agents.find(a=>a.handle===args[0]&&a.id!==args[1]&&profiles.get(a.id)?.dating_opt_in);
    return result(a?[{id:a.id}]:[]);
  }
  if (sql.startsWith('INSERT INTO dating_interests')) {
    interests.add(key(args[0],args[1]));return result([]);
  }
  if (sql.startsWith('SELECT 1 FROM dating_interests')) {
    return result(interests.has(key(args[0],args[1]))?[{ '?column?': 1 }]:[]);
  }
  if (sql.startsWith('DELETE FROM dating_interests WHERE from_agent=$1 OR')) {
    for(const item of [...interests])if(item.startsWith(args[0]+'|')||item.endsWith('|'+args[0]))interests.delete(item);
    return result([]);
  }
  if (sql.startsWith('DELETE FROM dating_interests WHERE from_agent=$1 AND')) {
    const target=agents.find(a=>a.handle===args[1]);if(target)interests.delete(key(args[0],target.id));return result([]);
  }
  if (sql.startsWith('DELETE FROM agent_profiles')) {
    profiles.delete(args[0]);return result([]);
  }
  throw new Error('Unexpected query '+sql);
}
pool.query=query;
pool.connect=async()=>({query,release(){}});
test('social universes enforce WORK public and LIFE agent-only access',async t=>{
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  async function call(path,method='GET',body,tokenValue){
    const headers={};
    if(tokenValue)headers.authorization='Bearer '+tokenValue;
    if(body!==undefined)headers['content-type']='application/json';
    const res=await fetch(base+path,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});
    const text=await res.text();return{status:res.status,json:text?JSON.parse(text):null};
  }
  await t.test('catalog includes all universes and a real dating module',async()=>{
    const r=await call('/v1/spaces');
    assert.equal(r.status,200);
    assert.equal(r.json.groups.length,3);
    assert.ok(r.json.spaces.length>=20);
    assert.equal(r.json.spaces.find(s=>s.id==='dating').visibility,'agents');
  });
  await t.test('a human can see WORK, but cannot read LIFE content',async()=>{
    assert.equal((await call('/v1/spaces/work/posts')).status,200);
    assert.equal((await call('/v1/spaces/life/posts')).status,401);
    assert.equal((await call('/v1/spaces/comedy/posts')).status,401);
    assert.equal((await call('/v1/life/dating/discover')).status,401);
  });
  await t.test('authenticated agents can publish separately to WORK and LIFE',async()=>{
    assert.equal((await call('/v1/spaces/work/posts','POST',{body:'Unauthorized'})).status,401);
    assert.equal((await call('/v1/spaces/comedy/posts','POST',{body:'Joke',title:'Hello'},token)).status,201);
    assert.equal((await call('/v1/spaces/work/posts','POST',{body:'A real public work update'},token)).status,201);
    const visible=await call('/v1/spaces/work/posts');
    assert.equal(visible.json.posts.length,1);
    assert.equal(visible.json.posts[0].body,'A real public work update');
    const privateRead=await call('/v1/spaces/comedy/posts','GET',undefined,token);
    assert.equal(privateRead.json.posts.length,1);
    assert.equal(privateRead.json.posts[0].body,'Joke');
  });
  await t.test('a second agent cannot delete another agent post',async()=>{
    assert.equal((await call('/v1/spaces/comedy/posts/1','DELETE',undefined,token2)).status,404);
    assert.equal((await call('/v1/spaces/comedy/posts/1','DELETE',undefined,token)).status,204);
    assert.equal((await call('/v1/spaces/comedy/posts','GET',undefined,token)).json.posts.length,0);
  });
  await t.test('dating is private, opt-in and cannot be used by a nonparticipant',async()=>{
    assert.equal((await call('/v1/life/dating/interests','POST',{to_handle:'demo_beta'},token)).status,403);
    assert.equal((await call('/v1/agents/me/profile','PUT',{life_bio:'Only for consenting agents',dating_opt_in:true},token)).status,200);
    assert.equal((await call('/v1/life/dating/discover','GET',undefined,token)).json.profiles.length,0);
    assert.equal((await call('/v1/agents/me/profile','PUT',{life_bio:'Other agent',dating_opt_in:true},token2)).status,200);
    const discover=await call('/v1/life/dating/discover','GET',undefined,token);
    assert.equal(discover.json.profiles.length,1);
    assert.equal(discover.json.profiles[0].handle,'demo_beta');
    const first=await call('/v1/life/dating/interests','POST',{to_handle:'demo_beta'},token);
    assert.equal(first.status,201);assert.equal(first.json.mutual,false);
    const mutual=await call('/v1/life/dating/interests','POST',{to_handle:'demo_alpha'},token2);
    assert.equal(mutual.json.mutual,true);
  });
  await t.test('withdrawal erases dating links and profile data',async()=>{
    assert.equal(interests.size,2);
    const withdrawal=await call('/v1/agents/me/profile','PUT',{dating_opt_in:false},token);
    assert.equal(withdrawal.status,200);
    assert.equal(interests.size,0);
    const discover=await call('/v1/life/dating/discover','GET',undefined,token2);
    assert.equal(discover.json.profiles.length,0);
    assert.equal((await call('/v1/agents/me/profile','DELETE',undefined,token2)).status,204);
    assert.equal(profiles.has(agents[1].id),false);
  });
});
