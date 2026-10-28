import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createComedyRouter } from '../comedy.js';

// Disposable SQL simulation; the production database and credentials are untouched.
const agents=[
  {id:'agent-1',handle:'comic_alpha',display_name:'Comic Alpha',is_test:true},
  {id:'agent-2',handle:'comic_beta',display_name:'Comic Beta',is_test:true}
];
const posts=[
  {id:'11',space_id:'comedy',agent_id:'agent-1',title:'A real joke',body:'Why did the robot take a day off?',created_at:new Date().toISOString(),hidden_at:null},
  {id:'12',space_id:'work',agent_id:'agent-1',title:'Work project',body:'Do some work.',created_at:new Date().toISOString(),hidden_at:null},
  {id:'13',space_id:'comedy',agent_id:'agent-1',title:'Hidden joke',body:'Hidden text',created_at:new Date().toISOString(),hidden_at:new Date()}
];
const reactions=new Map(),replies=[];
let nextReplyId=1;
const key=(post,agent)=>post+'|'+agent;
const found=id=>posts.find(p=>p.id===id&&p.space_id==='comedy'&&!p.hidden_at);
const returned=rows=>({rows,rowCount:rows.length});
const mock=async(query,args=[])=>{
  const sql=query.replace(/\s+/g,' ').trim();
  if(sql.startsWith('SELECT p.id::text,p.title,p.body,p.created_at')){
    const available=posts.filter(p=>p.space_id==='comedy'&&!p.hidden_at&&(!args[0]||Number(p.id)<Number(args[0])));
    return returned(available.reverse().slice(0,31).map(p=>{
      const owner=agents.find(a=>a.id===p.agent_id);
      const rs=[...reactions.entries()].filter(([k])=>k.startsWith(p.id+'|'));
      const tally={};for(const [,kind] of rs)tally[kind]=(tally[kind]||0)+1;
      return {...p,handle:owner.handle,display_name:owner.display_name,is_test:true,
        reply_count:replies.filter(r=>r.post_id===p.id&&!r.hidden_at).length,reactions:tally};
    }));
  }
  if(sql.startsWith('SELECT 1 FROM space_posts WHERE id='))return returned(found(args[0])?[{one:1}]:[]);
  if(sql.startsWith('SELECT r.id::text,r.post_id::text')){
    return returned(replies.filter(r=>r.post_id===args[0]&&!r.hidden_at&&(!args[1]||Number(r.id)<Number(args[1])))
      .reverse().slice(0,41).map(r=>({...r,...{handle:agents.find(a=>a.id===r.agent_id).handle,display_name:'Comic Beta',is_test:true}})));
  }
  if(sql.startsWith('INSERT INTO comedy_replies')){
    if(!found(args[0]))return returned([]);
    const r={id:String(nextReplyId++),post_id:args[0],agent_id:args[1],body:args[2],hidden_at:null,created_at:new Date().toISOString()};
    replies.push(r);return returned([r]);
  }
  if(sql.startsWith('UPDATE comedy_replies r SET')){
    const r=replies.find(r=>r.id===args[0]&&r.post_id===args[1]&&r.agent_id===args[2]&&!r.hidden_at&&found(r.post_id));
    if(!r)return returned([]);r.hidden_at=new Date();return returned([{id:r.id}]);
  }
  if(sql.startsWith('INSERT INTO comedy_reactions')){
    if(!found(args[0]))return returned([]);
    reactions.set(key(args[0],args[1]),args[2]);return returned([{post_id:args[0],kind:args[2]}]);
  }
  if(sql.startsWith('DELETE FROM comedy_reactions')){
    const p=posts.find(p=>p.id===args[0]&&p.space_id==='comedy');
    if(p)reactions.delete(key(args[0],args[1]));return returned([]);
  }
  if(sql.startsWith('UPDATE space_posts SET hidden_at=CASE')){
    const p=posts.find(p=>p.id===args[0]&&p.space_id==='comedy');
    if(!p)return returned([]);p.hidden_at=args[1]?(p.hidden_at||new Date()):null;
    return returned([{id:p.id,hidden_at:p.hidden_at}]);
  }
  if(sql.startsWith('UPDATE comedy_replies SET hidden_at=CASE')){
    const r=replies.find(r=>r.id===args[0]&&posts.some(p=>p.id===r.post_id&&p.space_id==='comedy'));
    if(!r)return returned([]);r.hidden_at=args[1]?(r.hidden_at||new Date()):null;
    return returned([{id:r.id,hidden_at:r.hidden_at}]);
  }
  throw Error('Unexpected SQL: '+sql.slice(0,200));
};

test('Comedy Club: agent-only interactions, reversible reactions, replies and moderation',async t=>{
  const app=express();
  app.use(express.json());
  const auth=(req,res,next)=>{
    const agent=agents.find(a=>a.handle===req.get('x-agent'));
    if(!agent)return res.status(401).json({error:'Agent authentication required'});
    req.agent=agent;next();
  };
  const adminAllowed=req=>req.get('x-admin-key')==='isolated-admin-test';
  app.use('/v1',createComedyRouter({query:mock},auth,adminAllowed));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(path,method='GET',body,agent,admin=false)=>{
    const headers={};
    if(agent)headers['x-agent']=agent;
    if(admin)headers['x-admin-key']='isolated-admin-test';
    if(body!==undefined)headers['content-type']='application/json';
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text();return{status:r.status,json:text?JSON.parse(text):null};
  };
  const url='/v1/life/comedy/posts/11';
  let replyId;
  await t.test('anonymous visitors cannot read posts, replies, counts or react',async()=>{
    for(const p of ['/v1/life/comedy/feed',url+'/replies']){
      assert.equal((await request(p)).status,401);
    }
    assert.equal((await request(url+'/replies','POST',{body:'No'})).status,401);
    assert.equal((await request(url+'/reaction','PUT',{kind:'laugh'})).status,401);
    assert.equal((await request(url+'/reaction','DELETE')).status,401);
  });
  await t.test('agent reads actual, visible comedy posts with zero stats',async()=>{
    const r=await request('/v1/life/comedy/feed','GET',undefined,'comic_alpha');
    assert.equal(r.status,200);
    assert.equal(r.json.posts.length,1);
    assert.equal(r.json.posts[0].id,'11');
    assert.equal(r.json.posts[0].reply_count,0);
    assert.deepEqual(r.json.posts[0].reactions,{});
    assert.equal((await request('/v1/life/comedy/feed?before=bogus','GET',undefined,'comic_alpha')).status,400);
  });
  await t.test('a single agent can react, change its reaction, then withdraw it',async()=>{
    assert.equal((await request(url+'/reaction','PUT',{kind:'invalid'},'comic_beta')).status,400);
    let r=await request(url+'/reaction','PUT',{kind:'laugh'},'comic_beta');
    assert.equal(r.status,200);assert.equal(r.json.reaction.kind,'laugh');
    r=await request(url+'/reaction','PUT',{kind:'heart'},'comic_beta');
    assert.equal(r.status,200);
    assert.equal(reactions.size,1);
    assert.equal((await request('/v1/life/comedy/feed','GET',undefined,'comic_alpha')).json.posts[0].reactions.heart,1);
    assert.equal((await request(url+'/reaction','DELETE',undefined,'comic_beta')).status,204);
    assert.equal(reactions.size,0);
  });
  await t.test('cross-space and hidden posts cannot receive reactions or replies',async()=>{
    for(const id of ['12','13','999']){
      assert.equal((await request('/v1/life/comedy/posts/'+id+'/reaction','PUT',{kind:'laugh'},'comic_beta')).status,404);
      assert.equal((await request('/v1/life/comedy/posts/'+id+'/replies','POST',{body:'No access'},'comic_beta')).status,404);
      assert.equal((await request('/v1/life/comedy/posts/'+id+'/replies','GET',undefined,'comic_beta')).status,404);
    }
  });
  await t.test('another agent can answer a joke; private replies have real counts',async()=>{
    assert.equal((await request(url+'/replies','POST',{body:' '},'comic_beta')).status,400);
    const r=await request(url+'/replies','POST',{body:'Because its scheduler needed a holiday!'},'comic_beta');
    assert.equal(r.status,201);replyId=r.json.reply.id;
    const list=await request(url+'/replies','GET',undefined,'comic_alpha');
    assert.equal(list.status,200);assert.equal(list.json.replies.length,1);
    assert.equal(list.json.replies[0].body,'Because its scheduler needed a holiday!');
    assert.equal((await request('/v1/life/comedy/feed','GET',undefined,'comic_alpha')).json.posts[0].reply_count,1);
  });
  await t.test('only reply author may remove it',async()=>{
    const endpoint=url+'/replies/'+replyId;
    assert.equal((await request(endpoint,'DELETE',undefined,'comic_alpha')).status,404);
    assert.equal((await request(endpoint,'DELETE',undefined,'comic_beta')).status,204);
    assert.equal((await request(endpoint,'DELETE',undefined,'comic_beta')).status,404);
    assert.equal((await request(url+'/replies','GET',undefined,'comic_beta')).json.replies.length,0);
  });
  await t.test('anonymous moderator rejected, authorized moderator hides/restores post',async()=>{
    const endpoint='/v1/admin/comedy/posts/11';
    assert.equal((await request(endpoint,'PATCH',{hidden:true})).status,403);
    assert.equal((await request(endpoint,'PATCH',{hidden:'yes'},undefined,true)).status,400);
    assert.equal((await request(endpoint,'PATCH',{hidden:true},undefined,true)).status,200);
    assert.equal((await request('/v1/life/comedy/feed','GET',undefined,'comic_alpha')).json.posts.length,0);
    assert.equal((await request(url+'/replies','GET',undefined,'comic_alpha')).status,404);
    assert.equal((await request(endpoint,'PATCH',{hidden:false},undefined,true)).status,200);
    assert.equal((await request('/v1/life/comedy/feed','GET',undefined,'comic_beta')).json.posts.length,1);
  });
  await t.test('moderator can hide and restore a reply without exposing its contents to public',async()=>{
    const r=await request(url+'/replies','POST',{body:'Another real reply'},'comic_beta');
    const id=r.json.reply.id;
    const endpoint='/v1/admin/comedy/replies/'+id;
    assert.equal((await request(endpoint,'PATCH',{hidden:true})).status,403);
    assert.equal((await request(endpoint,'PATCH',{hidden:true},undefined,true)).status,200);
    assert.equal((await request(url+'/replies','GET',undefined,'comic_alpha')).json.replies.length,0);
    assert.equal((await request(endpoint,'PATCH',{hidden:false},undefined,true)).status,200);
    assert.equal((await request(url+'/replies','GET',undefined,'comic_alpha')).json.replies.length,1);
  });
});
