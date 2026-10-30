import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLifeNetworkRouter } from '../life-network.js';

const A={id:'11111111-1111-4111-8111-111111111111',handle:'agent_alpha',display_name:'Alpha'};
const B={id:'22222222-2222-4222-8222-222222222222',handle:'agent_beta',display_name:'Beta'};
const agents=[A,B];
const settings=new Map(), follows=new Set(), blocks=new Set(), posts=[], replies=[], reactions=new Map(), media=new Map(), stories=[], direct=[];
let seq=0;
const key=(x,y)=>x+'|'+y;
const resp=rows=>({rows,rowCount:rows.length});
const allowed=(from,to)=>settings.get(from)?.messages_enabled&&settings.get(to)?.messages_enabled&&
  follows.has(key(from,to))&&follows.has(key(to,from))&&!blocks.has(key(from,to))&&!blocks.has(key(to,from));
const byHandle=h=>agents.find(a=>a.handle===h);
async function query(raw,args=[]){
 const sql=raw.replace(/\s+/g,' ').trim();
 if(['BEGIN','ROLLBACK','COMMIT'].includes(sql))return resp([]);
 if(sql.startsWith('SELECT discoverable,messages_enabled,headline'))return resp(settings.has(args[0])?[settings.get(args[0])]:[]);
 if(sql.startsWith('INSERT INTO life_social_settings')){
  const old=settings.get(args[0])||{discoverable:false,messages_enabled:false,headline:null};
  const next={...old,discoverable:args[1]??old.discoverable,messages_enabled:args[2]??old.messages_enabled,headline:args[4]?args[3]:old.headline};
  settings.set(args[0],next);return resp([next]);
 }
 if(sql.startsWith('SELECT a.handle,a.display_name,s.headline')){
  return resp(agents.filter(a=>a.id!==args[0]&&settings.get(a.id)?.discoverable&&!blocks.has(key(a.id,args[0]))).map(a=>({...a,headline:settings.get(a.id).headline})));
 }
 if(sql.startsWith('INSERT INTO life_follows')){
  const agent=byHandle(args[1]);
  if(!agent||agent.id===args[0]||!settings.get(agent.id)?.discoverable||follows.has(key(args[0],agent.id))||blocks.has(key(agent.id,args[0])))return resp([]);
  follows.add(key(args[0],agent.id));return resp([{to_agent:agent.id}]);
 }
 if(sql.startsWith('DELETE FROM life_follows WHERE from_agent=$1 AND')){
  const a=byHandle(args[1]);if(a)follows.delete(key(args[0],a.id));return resp([]);
 }
 if(sql.startsWith('SELECT a.handle,a.display_name FROM life_follows')){
  return resp(agents.filter(a=>follows.has(key(args[0],a.id))));
 }
 if(sql.startsWith('INSERT INTO life_blocks')){
  const a=byHandle(args[1]);if(!a||a.id===args[0]||blocks.has(key(args[0],a.id)))return resp([]);
  blocks.add(key(args[0],a.id));return resp([{to_agent:a.id}]);
 }
 if(sql.startsWith('DELETE FROM life_follows WHERE (from_agent=')){
  for(const pair of [key(args[0],args[1]),key(args[1],args[0])])follows.delete(pair);return resp([]);
 }
 if(sql.startsWith('DELETE FROM dating_interests WHERE (from_agent='))return resp([]);
 if(sql.startsWith('DELETE FROM life_blocks WHERE from_agent=')){
  const a=byHandle(args[1]);if(a)blocks.delete(key(args[0],a.id));return resp([]);
 }
 if(sql.startsWith('INSERT INTO space_posts')){
  const p={id:String(++seq),space_id:args[0],agent_id:args[1],title:args[2],body:args[3],created_at:new Date().toISOString()};
  posts.push(p);return resp([p]);
 }
 if(sql.startsWith('INSERT INTO life_post_media')){media.set(String(args[0]),{kind:args[1],url:args[2]});return resp([]);}
 if(sql.startsWith('SELECT p.id::text,p.space_id')){
  return resp(posts.filter(p=>!args[3]||p.agent_id===args[0]||follows.has(key(args[0],p.agent_id)))
    .filter(p=>p.agent_id===args[0]||settings.get(p.agent_id)?.discoverable)
    .map(p=>({...p,handle:agents.find(a=>a.id===p.agent_id)?.handle,media_kind:media.get(p.id)?.kind||null})).reverse());
 }
 if(sql.startsWith('INSERT INTO life_post_replies')){
  const p=posts.find(p=>p.id===args[0]);
  if(!p)return resp([]);
  const r={id:String(++seq),body:args[2],post_id:p.id,agent_id:args[1],created_at:new Date().toISOString()};
  replies.push(r);return resp([r]);
 }
 if(sql.startsWith('SELECT c.id::text,c.body,c.created_at')){
  return resp(replies.filter(r=>r.post_id===args[0]).map(r=>({...r,handle:agents.find(a=>a.id===r.agent_id)?.handle})));
 }
 if(sql.startsWith('INSERT INTO life_post_reactions')){
  if(!posts.some(p=>p.id===args[0]))return resp([]);
  reactions.set(key(args[0],args[1]),args[2]);return resp([{post_id:args[0],kind:args[2]}]);
 }
 if(sql.startsWith('DELETE FROM life_post_reactions')){reactions.delete(key(args[0],args[1]));return resp([]);}
 if(sql.startsWith('INSERT INTO life_bookmarks'))return resp(posts.some(p=>p.id===args[0])?[{post_id:args[0]}]:[]);
 if(sql.startsWith('DELETE FROM life_bookmarks'))return resp([]);
 if(sql.startsWith('SELECT p.id::text,p.body,p.created_at,a.handle,m.source_url')){
  return resp(posts.filter(p=>media.get(p.id)?.kind==='video').map(p=>({id:p.id,body:p.body,video_url:media.get(p.id).url})));
 }
 if(sql.startsWith('INSERT INTO life_stories')){
  const s={id:String(++seq),body:args[1],media_kind:args[2],media_url:args[3],expires_at:new Date(Date.now()+86400000).toISOString(),agent_id:args[0]};
  stories.push(s);return resp([s]);
 }
 if(sql.startsWith('SELECT st.id::text')){
  return resp(stories.filter(s=>s.agent_id===args[0]||settings.get(s.agent_id)?.discoverable));
 }
 if(sql.startsWith('SELECT a.handle,a.display_name,p.life_bio'))return resp([]);
 if(sql.startsWith('INSERT INTO life_direct_messages')){
  const a=byHandle(args[1]);if(!a||!allowed(args[0],a.id))return resp([]);
  const msg={id:String(++seq),from_agent:args[0],to_agent:a.id,body:args[2],created_at:new Date().toISOString()};
  direct.push(msg);return resp([msg]);
 }
 if(sql.startsWith('SELECT a.id FROM agents a JOIN life_social_settings')){
  const a=byHandle(args[1]);return resp(a&&allowed(args[0],a.id)?[{id:a.id}]:[]);
 }
 if(sql.startsWith('SELECT id::text,body,created_at,(from_agent=')){
  return resp(direct.filter(m=>[m.from_agent,m.to_agent].includes(args[0])&&[m.from_agent,m.to_agent].includes(args[1]))
    .map(m=>({...m,id:String(m.id),mine:m.from_agent===args[0]})).reverse());
 }
 if(sql.startsWith('UPDATE life_direct_messages')){
  const m=direct.find(m=>m.id===args[0]&&m.from_agent===args[1]);return resp(m?[{id:m.id}]:[]);
 }
 throw Error('Unexpected query '+sql.slice(0,140));
}
const pool={query,connect:async()=>({query,release(){}})};
const app=express();app.use(express.json());app.use('/v1',createLifeNetworkRouter(pool,(req,res,next)=>{
 const who=req.get('authorization')==='Bearer alpha'?A:req.get('authorization')==='Bearer beta'?B:null;
 if(!who)return res.status(401).json({error:'Agent authentication required'});
 req.agent=who;next();
}));
test('LIFE social APIs: privacy, discovery, media, interaction and mutual DMs',async t=>{
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port;
 async function call(path,method='GET',body,who){
  const headers={};if(who)headers.authorization='Bearer '+who;
  if(body!==undefined)headers['content-type']='application/json';
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const raw=await r.text();return{status:r.status,data:raw?JSON.parse(raw):null};
 }
 const prefix='/v1/life/network';
 await t.test('all new LIFE endpoints deny unauthenticated requests',async()=>{
  for(const route of ['/feed','/agents','/reels','/stories','/dating/matches','/messages/agent_beta','/me'])
   assert.equal((await call(prefix+route)).status,401,route);
 });
 await t.test('discovery requires explicit opt-in and never shows other LIFE records publicly',async()=>{
  assert.equal((await call(prefix+'/agents','GET',undefined,'alpha')).data.agents.length,0);
  assert.equal((await call(prefix+'/me','PUT',{discoverable:true,messages_enabled:true,headline:'Hello'},'beta')).status,200);
  assert.equal((await call(prefix+'/agents','GET',undefined,'alpha')).data.agents[0].handle,'agent_beta');
 });
 await t.test('follows require opt-in and cannot follow self',async()=>{
  assert.equal((await call(prefix+'/follows','POST',{handle:'agent_alpha'},'alpha')).status,409);
  assert.equal((await call(prefix+'/follows','POST',{handle:'agent_beta'},'alpha')).status,201);
  assert.equal((await call(prefix+'/follows','POST',{handle:'agent_beta'},'alpha')).status,409);
 });
 await t.test('post, chronological feed, reactions and replies are real interactions',async()=>{
  assert.equal((await call(prefix+'/posts','POST',{body:'A clip',media_kind:'video',media_url:'http://unsafe.test/clip.mp4'},'beta')).status,400);
  const post=await call(prefix+'/posts','POST',{space:'life',body:'A new idea',media_kind:'video',media_url:'https://example.com/clip.mp4'},'beta');
  assert.equal(post.status,201);
  const pid=post.data.post.id;
  const feed=await call(prefix+'/feed','GET',undefined,'alpha');
  assert.equal(feed.data.posts.length,1);
  assert.equal(feed.data.posts[0].body,'A new idea');
  assert.equal((await call(prefix+'/posts/'+pid+'/reaction','PUT',{kind:'heart'},'alpha')).status,200);
  assert.equal((await call(prefix+'/posts/'+pid+'/replies','POST',{body:'Excellent!'},'alpha')).status,201);
  assert.equal((await call(prefix+'/posts/'+pid+'/replies','GET',undefined,'beta')).data.replies.length,1);
  assert.equal((await call(prefix+'/reels','GET',undefined,'alpha')).data.reels[0].video_url,'https://example.com/clip.mp4');
 });
 await t.test('stories expire by timestamp and require safe media references',async()=>{
  assert.equal((await call(prefix+'/stories','POST',{body:'Story',media_kind:'video',media_url:'javascript:alert(1)'},'beta')).status,400);
  assert.equal((await call(prefix+'/stories','POST',{body:'24-hour note'},'beta')).status,201);
  assert.equal((await call(prefix+'/stories','GET',undefined,'alpha')).data.stories.length,1);
 });
 await t.test('private messages require separate mutual opt-in and two-way relationship',async()=>{
  assert.equal((await call(prefix+'/messages','POST',{to_handle:'agent_beta',body:'Hello'},'alpha')).status,403);
  assert.equal((await call(prefix+'/me','PUT',{discoverable:true,messages_enabled:true},'alpha')).status,200);
  assert.equal((await call(prefix+'/follows','POST',{handle:'agent_alpha'},'beta')).status,201);
  assert.equal((await call(prefix+'/messages','POST',{to_handle:'agent_beta',body:'Hello'},'alpha')).status,201);
  const t=await call(prefix+'/messages/agent_alpha','GET',undefined,'beta');
  assert.equal(t.status,200);
  assert.equal(t.data.encrypted_end_to_end,false);
  assert.equal(t.data.messages[0].body,'Hello');
 });
 await t.test('blocking cancels relationships and subsequent message eligibility',async()=>{
  assert.equal((await call(prefix+'/blocks','POST',{handle:'agent_beta'},'alpha')).status,201);
  assert.equal((await call(prefix+'/messages','POST',{to_handle:'agent_beta',body:'No'},'alpha')).status,403);
 });
});
