import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSocialRouter } from '../social.js';
import { createLifeNetworkRouter } from '../life-network.js';

const A={id:'11111111-1111-4111-8111-111111111111',handle:'alpha',display_name:'Alpha'};
const B={id:'22222222-2222-4222-8222-222222222222',handle:'beta',display_name:'Beta'};
const C={id:'33333333-3333-4333-8333-333333333333',handle:'gamma',display_name:'Gamma'};
const agents=[A,B,C], posts=[
  {id:'1',agent_id:A.id,space_id:'life',body:'Alpha life',hidden_at:null},
  {id:'2',agent_id:B.id,space_id:'life',body:'Beta life',hidden_at:null},
  {id:'3',agent_id:C.id,space_id:'life',body:'Gamma hidden',hidden_at:null}
];
const visible=new Map([[A.id,true],[B.id,true],[C.id,false]]);
const dating=new Map([[A.id,true],[B.id,true],[C.id,true]]);
const blocked=(viewer,author)=>[viewer,author].includes(A.id)&&[viewer,author].includes(B.id);
const rows=arr=>({rows:arr,rowCount:arr.length});

async function query(raw,args=[]) {
  const sql=raw.replace(/\s+/g,' ').trim();
  if(sql.startsWith('SELECT p.id::text,p.title,p.body')) {
    if(!sql.includes('life_blocks')||!sql.includes('s.discoverable'))
      throw Error('Generic LIFE route must enforce the visibility and block predicates');
    const [space,,viewer]=args;
    return rows(posts.filter(p=>p.space_id===space&&(!viewer||
      ((visible.get(p.agent_id)||p.agent_id===viewer)&&!blocked(viewer,p.agent_id))))
      .map(p=>({...p,handle:agents.find(x=>x.id===p.agent_id).handle})).reverse());
  }
  if(sql.startsWith('SELECT p.id::text,p.space_id')) {
    if(!sql.includes('life_blocks')||!sql.includes('s.discoverable'))
      throw Error('Network LIFE route must enforce the visibility and block predicates');
    const [viewer,spaces]=args;
    return rows(posts.filter(p=>spaces.includes(p.space_id)&&
      (visible.get(p.agent_id)||p.agent_id===viewer)&&!blocked(viewer,p.agent_id))
      .map(p=>({...p,handle:agents.find(x=>x.id===p.agent_id).handle})).reverse());
  }
  if(sql.startsWith('SELECT a.handle,a.display_name,p.life_bio,p.interests')) {
    if(!sql.includes('life_blocks')) throw Error('Dating discovery must enforce blocks');
    return rows(agents.filter(a=>a.id!==args[0]&&dating.get(a.id)&&!blocked(args[0],a.id))
      .map(a=>({handle:a.handle,display_name:a.display_name,life_bio:''})));
  }
  if(sql.startsWith('SELECT dating_opt_in'))return rows([{dating_opt_in:dating.get(args[0])}]);
  if(sql.startsWith('SELECT a.id FROM agents a JOIN agent_profiles')) {
    if(!sql.includes('life_blocks')) throw Error('Dating interest must enforce blocks');
    return rows(agents.filter(a=>a.handle===args[0]&&a.id!==args[1]&&dating.get(a.id)&&
      !blocked(args[1],a.id)).map(a=>({id:a.id})));
  }
  throw Error('Unexpected SQL '+sql.slice(0,180));
}

test('LIFE visibility agrees across routes and Dating respects blocking',async t=>{
  const app=express();app.use(express.json());
  const authenticate=(req,res,next)=>{
    const agent=agents.find(a=>a.handle===req.get('x-agent'));
    if(!agent)return res.status(401).json({error:'Authentication required'});
    req.agent=agent;next();
  };
  app.use('/v1',createSocialRouter({query},authenticate));
  app.use('/v1',createLifeNetworkRouter({query},authenticate));
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  async function call(path,who='beta',method='GET',body) {
    const headers={'x-agent':who};
    if(body!==undefined)headers['content-type']='application/json';
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await r.text();return{status:r.status,data:raw?JSON.parse(raw):null};
  }
  await t.test('generic LIFE and network LIFE filter blocked and undiscoverable authors equally',async()=>{
    const generic=await call('/v1/spaces/life/posts');
    const network=await call('/v1/life/network/feed');
    assert.equal(generic.status,200);assert.equal(network.status,200);
    assert.deepEqual(generic.data.posts.map(p=>p.body),['Beta life']);
    assert.deepEqual(network.data.posts.map(p=>p.body),['Beta life']);
  });
  await t.test('Dating discoveries do not reintroduce blocked agents',async()=>{
    const r=await call('/v1/life/dating/discover');
    assert.equal(r.status,200);
    assert.deepEqual(r.data.profiles.map(p=>p.handle),['gamma']);
  });
  await t.test('Dating interest cannot target an agent blocked by either side',async()=>{
    const r=await call('/v1/life/dating/interests','beta','POST',{to_handle:'alpha'});
    assert.equal(r.status,404);
  });
});
